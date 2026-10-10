# Basix Web Call sample app

A Node server obtains a short-lived WebSocket ticket from Basix. The browser
uses the library in this repository to place one audio call. The API token stays
on the Node server.

Requires Node.js 20 or later. From the repository root:

```sh
npm install
cd sample_app
npm install
cp config/default.json.sample config/default.json
```

Installing in `sample_app` also installs the parent library's dependencies.
This is required because npm does not install dependencies of the linked
`file:..` package automatically.

Edit `config/default.json`:

The server checks `/etc/secrets/config.json` first (for example, a Render secret
file). If that file does not exist, it loads `sample_app/config/default.json`.
Both files use the same configuration format. An unreadable or invalid secret
file stops startup rather than falling back to the local configuration.

- `basix_base_url`: Basix HTTP base URL including `/basix`, for example
  `https://bcs.brastel.com/basix`.
- `basix_domain_name`: domain owning the API token, such as `example.basix.ne.jp`.
- `basix_api_token`: the API token for that domain.
- `trust_proxy`: set to `true` to use `X-Forwarded-Host` and `X-Forwarded-Proto`
  when a request lacks browser fetch metadata. These forwarded headers are
  ignored by default.
- `public_origin` (optional): pins the allowed origin to a specific scheme,
  host, and port. This overrides automatic proxy detection when set.
- `host` and `port`: local listener, default `127.0.0.1:3000`.
- `tls.enabled`: serve HTTPS directly from Node when `true`; defaults to `false`.
- `tls.key_file` and `tls.cert_file`: PEM private key and certificate chain files
  required when TLS is enabled. Absolute paths are supported; relative paths
  resolve from `sample_app`, regardless of the current working directory.

Then run:

```sh
npm start
```

Open `http://localhost:3000`, enter your peer name and a destination, click **Call**, and allow
microphone access. **Hang up** also works while a ticket is being obtained.
Each click creates a fresh library instance and ticket. **Enable audio** appears
if the browser blocks playback. Use HTTPS when accessing the app beyond localhost.
The **Dialpad** is always enabled. Before calling, click `0`–`9`, `*`, or `#`
to enter the destination at the text cursor or replace selected text. During an
answered call, the same keys send DTMF tones to a voice menu using RTP
telephone-event media (with SIP.js's INFO fallback). While connecting or ending
a call, keys provide feedback but do not change the booked destination or send
DTMF. After the call ends, they enter the destination again.
**Call**, **Hang up**, **Clear**, and **Backspace** are in a column beside the
dialpad. Clear removes the entire destination; Backspace removes selected digits
or the digit before the cursor. Destination editing controls disable during calls.
Keys visibly depress and play a short local keypad tone when pressed. This
feedback sound plays through your speakers; the IVR digit is sent separately
through the call's DTMF media.

`npm start` rebuilds the browser bundle with esbuild. After changing browser or
library code, restart the app or run `npm run build` and reload the page.

For your reverse proxy, open `https://<your-host>/basix_webcall_test/`. Asset and
ticket URLs are relative to that path. The Node server accepts requests with
the prefix preserved or stripped. For nginx on the same machine, add this to
your existing HTTPS server block:

```nginx
location = /basix_webcall_test {
    return 302 /basix_webcall_test/;
}

location ^~ /basix_webcall_test/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

The trailing slash on `proxy_pass` strips the prefix before forwarding.
The `^~` modifier prevents regex locations (including a catch-all regex) from
overriding the sample app's route.
Modern browsers send `Sec-Fetch-Site: same-origin` for the page's ticket request.
The app accepts that signal even if the proxy changes the Host header or drops
the public port. Requests marked cross-site or same-site are rejected. No
machine-specific origin or forwarded headers are needed for this browser flow.

For requests without fetch metadata, `trust_proxy: true` derives the public
origin from the two forwarded headers, including nonstandard ports. The proxy
must overwrite these headers and the Node listener should be accessible only
through your proxy when trusting them. Without forwarded headers, the app checks
the incoming Host header. Rejected requests log the origin-related headers on
the Node console to help diagnose proxy configuration.

For a fixed origin instead, you can optionally set:

```json
"public_origin": "https://192.168.225.24:1443"
```

Remove `public_origin` to enable automatic detection. Restart the Node server
after changing its configuration.

To deploy without a reverse proxy, update these settings in `config/default.json`
alongside your existing Basix settings:

```json
{
  "host": "0.0.0.0",
  "port": 8443,
  "trust_proxy": false,
  "tls": {
    "enabled": true,
    "key_file": "/path/to/privkey.pem",
    "cert_file": "/path/to/fullchain.pem"
  }
}
```

Use a browser-trusted certificate for your public hostname and make the files
readable by the Node process. Run `npm start` and open
`https://<your-host>:8443/`; `/basix_webcall_test/` also continues to work.
Choose your listening port in the configuration. If you set `public_origin`,
update it to the new URL, or remove it to detect the host automatically.
HTTPS is required for browser microphone access beyond localhost.
Restart the app after changing settings or renewing certificate files.
Keep `tls.enabled: false` and `trust_proxy: true` for your existing HTTPS proxy.

For Render, set the service root directory to `sample_app`, the build command
to `npm install --include=dev && npm run build`, and the start command to
`npm start`. Include development dependencies during the build because esbuild
is needed to produce the browser bundle. Provide `/etc/secrets/config.json`
with your Basix settings and `host: "0.0.0.0"`, `port: 10000`,
`trust_proxy: true`, and `tls: { "enabled": false }`.
Render terminates HTTPS before forwarding HTTP to Node. If you configure a
different Render listening port, use that port in the JSON as well.

The SIP WebSocket connects directly from the browser to Basix using
`wss://<host>/basix/api/ws_sip?ticket=<ticket>`.
The SIP INVITE includes `X-DestTicket` with that same ticket ID.

The backend sends `POST <basix_base_url>/api/gen_ws_ticket` with Basic
authentication (`basix_domain_name:basix_api_token`) and JSON:

```json
{ "uri": "/basix/api/ws_sip", "destination": "0312341234", "peer_name": "Test caller" }
```

It expects `{ "result_code": 0, "ticket": "..." }`. Basix binds the destination
to that ticket, and the browser dials `destination_ticket.<ticket>@anything` as
required by the end-user SIP frontend. The WebSocket host follows
`basix_base_url`. Tickets expire after ten seconds, so the browser starts the
call immediately after obtaining one.
The peer name is required, trimmed, and limited to 128 characters. It is included
in the `gen_ws_ticket` request as `peer_name`.

Only the three files in `public` are served; `config/default.json` is ignored by
Git. The sample runs locally without application login. Add appropriate access
control before making its ticket endpoint publicly available.

Run `npm test` for the backend tests using a mocked Basix API. A valid domain,
token, and destination are needed for a live call.
