/**
 * The privacy policy, served as a plain HTML page at `/privacy`.
 *
 * It lives in the Worker because Google Play requires the policy to be at a
 * public, non-expiring URL that is reachable without login, and this is the
 * only public host this project owns. A gist or a docs site would be a second
 * thing to keep alive; this deploys with everything else.
 *
 * ACCURACY IS THE POINT. Play's Data safety declaration must match what the app
 * actually does, and a mismatch is a policy violation rather than a paperwork
 * error. Every claim below is checked against the code: the app has no accounts
 * and no analytics SDK, its only persistent storage is the TanStack Query cache
 * in AsyncStorage, and AdMob is the single third party that receives anything.
 * If that ever stops being true, this page changes in the same commit.
 */

/**
 * Deliberately public, unlike SEC_USER_AGENT. A privacy policy is void without
 * a reachable contact, and Play publishes a developer email on the store
 * listing regardless — so there is nothing to protect by hiding it here.
 */
const CONTACT_EMAIL = 'leagumihail@gmail.com';

const LAST_UPDATED = '2 August 2026';

export function privacyPolicyResponse(): Response {
  return new Response(PRIVACY_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Long cache: the policy changes on deploys, not on data.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finocus — Privacy Policy</title>
<style>
  :root { color-scheme: light dark; }
  body {
    max-width: 44rem; margin: 0 auto; padding: 2rem 1.25rem 4rem;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; }
  .updated { color: #6b7280; font-size: 0.9rem; margin-top: 0; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.4rem 0; }
  a { color: #1f6feb; }
  code { font-size: 0.9em; }
</style>
</head>
<body>

<h1>Finocus — Privacy Policy</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>

<p>
  Finocus shows public market data: S&amp;P 500 statistics, 13F holdings filed
  with the U.S. Securities and Exchange Commission, and an economic calendar.
  This page explains exactly what the app handles and what it does not.
</p>

<h2>What Finocus does not collect</h2>
<p>
  Finocus has no accounts and no sign-in. It never asks for your name, email
  address, phone number, location, contacts, photos, or any financial or
  brokerage information, and it contains no analytics or crash-reporting SDK.
  There is no profile of you to build, because nothing identifies you to us.
</p>

<h2>Data stored on your device</h2>
<p>
  The app caches the market data it downloads so it opens quickly and works
  briefly without a connection. This cache holds only public market data, stays
  on your device, and is never sent anywhere. Clearing the app's storage or
  uninstalling Finocus deletes it.
</p>

<h2>Data our server receives</h2>
<p>
  The app fetches data from our own API, which runs on Cloudflare Workers. Like
  any web request, this sends your device's IP address and a standard request
  header to the server, which Cloudflare processes to route the request and
  protect against abuse. We do not log these requests to build usage profiles,
  we do not link them to any identifier, and we do not sell or share them. The
  requests carry no information about you beyond what any HTTP request carries.
</p>

<h2>Advertising</h2>
<p>
  Finocus displays a banner advertisement supplied by Google AdMob. To serve and
  measure ads, Google may collect and process your device's advertising
  identifier along with device and ad-interaction information. This data goes to
  Google, not to us; we receive only aggregate revenue totals, which do not
  identify anyone.
</p>
<p>
  Google's handling of this data is described in
  <a href="https://policies.google.com/technologies/partner-sites">How Google uses information from sites or apps that use our services</a>
  and its <a href="https://policies.google.com/privacy">Privacy Policy</a>.
</p>

<h2>Your choices</h2>
<ul>
  <li>
    <strong>In the European Economic Area, the United Kingdom and Switzerland,</strong>
    Finocus asks for your consent before personalised ads are served, using
    Google's consent form. You can change or withdraw that choice at any time
    from the shield icon in the app's top-right corner.
  </li>
  <li>
    <strong>On any Android device,</strong> you can reset or delete your
    advertising ID, and turn off ad personalisation, under
    <em>Settings → Privacy → Ads</em>. Deleting the ID stops apps from receiving it.
  </li>
  <li>
    <strong>To remove everything the app has stored,</strong> uninstall Finocus
    or clear its storage in Android settings.
  </li>
</ul>

<h2>Children</h2>
<p>
  Finocus is a financial information tool intended for adults. It is not
  directed at children, and we do not knowingly collect information from them.
</p>

<h2>About the market data</h2>
<p>
  Finocus is an information tool, not financial advice, and nothing in it is a
  recommendation to buy or sell anything. Holdings come from Form 13F, which
  covers only long U.S.-listed equities, ADRs and some options — no cash, bonds,
  short positions or foreign listings — and is filed up to 45 days after the
  quarter it describes. Holdings shown are therefore historical, not a manager's
  current portfolio.
</p>

<h2>Changes</h2>
<p>
  If this policy changes, the date at the top of this page changes with it.
</p>

<h2>Contact</h2>
<p>
  Questions about this policy, or about data associated with the app:
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
</p>

</body>
</html>
`;
