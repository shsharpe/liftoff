# Liftoff

A self-verifying deployment page for cPanel AI App Hosting. Open it after deploy and it checks, live, that your app really is running the way the platform says it is. Nothing on the page is mocked: a check that can't be confirmed stays amber.

## Deploy

1. In cPanel (Meridian), go to **Websites & Apps**, add a website, and choose **Node.js**.
2. Pick **Upload a file** and drop in `liftoff-cpanel-app.zip`. Select **Continue**.
3. Confirm the defaults on the Deploy step:
   - Framework: Express
   - Build command: `npm run build`
   - Start command: `npm start`
   - Port: the app reads the `PORT` environment variable and falls back to `3000`
4. Deploy, then open the URL.

The app is deployed to a new subdomain. HTTPS comes from AutoSSL after the deploy, so the last station may stay amber for a short while.

## What the stations check

| Station | Passes when |
| --- | --- |
| Source unpacked | The server is running from the uploaded `package.json` |
| Framework signal | `package.json` lists dependencies the wizard can read |
| Built separately | `build-info.json` was written by a host other than the one now running |
| Running in a container | A Podman or Docker marker file exists |
| Behind the proxy | The request carries forwarding headers from the web server |
| Served over HTTPS | The browser loaded the page over `https:` |

## Layout

```
package.json         express 4.21.2 only, `build` and `start` scripts
package-lock.json    npm lockfile (the platform reads the package manager from this)
server.js            stats API, checks, /healthz
scripts/build.js     records where the build ran
public/              index.html, styles.css, app.js
```

No `.env` file is included on purpose. If you add one, keep it out of the archive and use the wizard's environment variable editor instead.
