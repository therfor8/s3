import {
  makeReadableWebSocketStream,
  processVlessHeader,
  vlessJs,
} from 'vless-js';
import { connect } from 'cloudflare:sockets';
import { page404 } from '../util';

interface Env {
  KV: KVNamespace;
  UUID: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const userID = context.env['UUID'];
  if (context.params.wspath !== userID) {
    return new Response(``, {
      status: 401,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'WWW-Authenticate': 'Basic',
      },
    });
  }
  console.log(context.params.wspath);
  let address = '';
  let portWithRandomLog = '';

  const log = (info: string, event?: any) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };

  var doh = "https://mozilla.cloudflare-dns.com/dns-query";
  var dns = async (domain) => {
    const response = await fetch(`${doh}?name=${domain}&type=A`, {
      method: "GET",
      headers: {
        "Accept": "application/dns-json"
      }
    });
    const data = await response.json();
    const ans = data?.Answer;
    return ans?.find((record) => record.type === 1)?.data;
  };
  var isCloudFlareIP = (ip) => {
    const CFIP = [
      [1729491968, -1024],
      [1729546240, -1024],
      [1730085888, -1024],
      [1745879040, -524288],
      [1746403328, -262144],
      [1822605312, -16384],
      [-2097133568, -1024],
      [-1922744320, -16384],
      [-1566703616, -131072],
      [-1405091840, -524288],
      [-1376440320, -4096],
      [-1133355008, -4096],
      [-1101139968, -4096],
      [-974458880, -1024],
      [-970358784, -32768]
    ];
    const isIp4InCidr = (ip2, cidr) => {
      const [a, b, c, d] = ip2.split(".").map(Number);
      ip2 = a << 24 | b << 16 | c << 8 | d;
      const [range, mask] = cidr;
      return (ip2 & mask) === range;
    };
    return CFIP.some((cidr) => isIp4InCidr(ip, cidr));
  };
  

  const upgradeHeader = context.request.headers.get('Upgrade');
  // index page
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return new Response(`need Upgrade to ws`, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    });
  }

  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  const earlyDataHeader =
    context.request.headers.get('sec-websocket-protocol') || '';
  let remoteSocket: TransformStream = null;
  webSocket.accept();

  const readableWebSocketStream = makeReadableWebSocketStream(
    webSocket,
    earlyDataHeader,
    log
  );
  let vlessResponseHeader = new Uint8Array([0, 0]);
  let remoteConnectionReadyResolve: Function;

  // ws-->remote

  readableWebSocketStream.pipeTo(
    new WritableStream({
      async write(chunk, controller) {
        if (remoteSocket) {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
          return;
        }

        const {
          hasError,
          message,
          portRemote,
          addressRemote,
          rawDataIndex,
          vlessVersion,
          isUDP,
        } = processVlessHeader(chunk, userID);
        address = addressRemote || '';
        portWithRandomLog = `${portRemote}--${Math.random()} ${
          isUDP ? 'udp ' : 'tcp '
        } `;
        // if UDP but port not DNS port, close it
        if (isUDP && portRemote != 53) {
          controller.error('UDP proxy only enable for DNS which is port 53');
          webSocket.close(); // server close will not casuse worker throw error
          return;
        }
        if (hasError) {
          controller.error(message);
          webSocket.close(); // server close will not casuse worker throw error
          return;
        }
        vlessResponseHeader = new Uint8Array([vlessVersion![0], 0]);
        const rawClientData = chunk.slice(rawDataIndex!);
        let queryip = "";
        queryip = await dns(addressRemote);
        if (queryip && isCloudFlareIP(queryip)) {
            queryip = "dns2.easydns.com";
        } else {
            queryip = addressRemote;
        }
        remoteSocket = connect({
          hostname: queryip ? queryip : addressRemote,
          port: portRemote
        }, {"secureTransport": "starttls", "allowHalfOpen": true});
        log(`connected`);

        const writer = remoteSocket.writable.getWriter();
        await writer.write(rawClientData); // first write, nomal is tls client hello
        writer.releaseLock();

        // remoteSocket ready
        remoteConnectionReadyResolve(remoteSocket);
      },
      close() {
        console.log(
          `[${address}:${portWithRandomLog}] readableWebSocketStream is close`
        );
      },
      abort(reason) {
        console.log(
          `[${address}:${portWithRandomLog}] readableWebSocketStream is abort`,
          JSON.stringify(reason)
        );
      },
    })
  );

  (async () => {
    await new Promise((resolve) => (remoteConnectionReadyResolve = resolve));

    // remote--> ws
    let count = 0;
    remoteSocket.readable
      .pipeTo(
        new WritableStream({
          start() {
            if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
              webSocket.send(vlessResponseHeader!);
            }
          },
          async write(chunk: Uint8Array, controller) {
            if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
              if (count++ > 20000) {
                // cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
                await delay(1);
              }
              webSocket.send(chunk);
              // console.log(chunk.byteLength);
            } else {
              controller.error('webSocket.readyState is not open, maybe close');
            }
          },
          close() {
            console.log(
              `[${address}:${portWithRandomLog}] remoteConnection!.readable is close`
            );
          },
          abort(reason) {
            console.error(
              `[${address}:${portWithRandomLog}] remoteConnection!.readable abort`,
              reason
            );
          },
        })
      )
      .catch((error) => {
        console.error(
          `[${address}:${portWithRandomLog}] processWebSocket has exception `,
          error.stack || error
        );
        safeCloseWebSocket(webSocket);
      });
  })();

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
};

function safeCloseWebSocket(ws: WebSocket) {
  try {
    if (ws.readyState !== WebSocket.READY_STATE_CLOSED) {
      ws.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

function delay(ms) {
  return new Promise((resolve, rej) => {
    setTimeout(resolve, ms);
  });
}
