const CONTACT = 'shanto@iishanto.com'
const POLICY_URL = 'https://iishanto.com/app/serverkit/privacy-policy.html'

// Cloudflare rewrites visible addresses into "[email protected]" and relies on a
// script this page's policy blocks, so the address is kept out of that rewrite.
const keepEmail = html => `<!--email_off-->${html}<!--/email_off-->`

export const DATA_DELETION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ServerKit Data Deletion</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #333; }
        h1 { color: #1a1a1a; border-bottom: 2px solid #1a73e8; padding-bottom: 0.5rem; }
        h2 { color: #1a73e8; margin-top: 2rem; }
        a { color: #1a73e8; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .effective-date { color: #666; font-style: italic; margin-bottom: 2rem; }
        ul { padding-left: 1.5rem; }
        li { margin-bottom: 0.5rem; }
        .box { background: #f3f7fe; border: 1px solid #c9dafc; border-radius: 8px; padding: 1rem 1.25rem; }
    </style>
</head>
<body>
    <h1>ServerKit Data Deletion</h1>
    <p class="effective-date">Effective Date: October 17, 2026</p>

    <p>ServerKit has no accounts. Your server credentials and settings stay on your phone, and we hold only the small amount of data described in the <a href="${POLICY_URL}">Privacy Policy</a>. This page explains how to ask us to delete it.</p>

    <h2>How to request deletion</h2>
    <div class="box">
        <p>Email ${keepEmail(`<a href="mailto:${CONTACT}?subject=ServerKit%20data%20deletion">${CONTACT}</a>`)} with the subject <strong>ServerKit data deletion</strong> and tell us which data to delete (see the list below). We reply to confirm once it is done, normally within 30 days.</p>
    </div>
    <p>Deletion is permanent and cannot be undone.</p>

    <h2>What we can delete, and what to tell us</h2>
    <ul>
        <li><strong>Help &amp; feedback conversations</strong> (your messages, the details sent with them, your country, and your push token). Because a conversation is linked only to a random ID and not to your name or account, tell us roughly when you wrote and what about, so we can find it. We delete the stored messages, the copy of the conversation on our Telegram group (including any screenshots), and the push token. Conversations are also deleted automatically 365 days after the last message.</li>
        <li><strong>AI Agent free-trial record</strong> (an anonymous identity hash, a prompt count, and the start of the trial window). Send a recent Google Play Order ID or purchase token so we can locate the record.</li>
        <li><strong>Monitor Agent push token.</strong> You can remove it yourself at any time: disable the Monitor Agent and revoke the integration token on its setup screen in the app. This deletes the token from our relay.</li>
        <li><strong>Onboarding survey and install records.</strong> These hold only anonymous answers and an approximate location, with no identifier that links them to you, so we cannot pick out one person's record. They are deleted automatically after 180 days.</li>
    </ul>

    <h2>Data you can remove yourself</h2>
    <ul>
        <li><strong>Everything stored on your phone</strong> (servers, credentials, keys, history, Labs virtual machine, settings): uninstall the app, or clear its data in Android settings, or use Settings &rarr; Privacy in the app. This data is never sent to us.</li>
        <li><strong>Analytics:</strong> switch off anonymous usage analytics at any time in Settings &rarr; Privacy.</li>
        <li><strong>Purchases:</strong> payment and billing data are held by Google Play, not by us. Manage or request deletion of it through your Google account.</li>
    </ul>

    <h2>Questions</h2>
    <p>Contact the ServerKit developer at ${keepEmail(`<a href="mailto:${CONTACT}">${CONTACT}</a>`)}.</p>
</body>
</html>
`
