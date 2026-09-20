// api/_thumbjob.js
//
// Ask the thumbnail workflow to run now, because a page just published.
//
// The scheduled job in .github/workflows/thumbnails.yml runs every three hours,
// which is the wrong latency for the one moment a page is most likely to be
// shared: immediately after it is made. Until its thumbnail exists the gallery
// shows a placeholder AND og:image falls back to the generic site card, so a
// link posted in the first minutes shows the AI Netscape logo rather than the
// page itself.
//
// A browser cannot run here -- that is the whole reason the rendering lives in
// Actions -- so this does not render anything. It dispatches the workflow that
// does. End to end that is roughly two minutes rather than up to three hours,
// and it adds nothing to the serverless bundle.
//
// The schedule stays as the safety net. This is best-effort by construction:
// no token, a GitHub outage, a rate limit or a rename of the workflow file all
// end the same way -- a log line, and the next scheduled run picks the page up.
// Nothing here may ever affect whether a generation succeeds.

const OWNER = 'tstringham';
const REPO = 'ainetscape';
const WORKFLOW = 'thumbnails.yml';
const REF = 'main';

// Short. This is fire-and-forget on a request that has already streamed its
// body to the user; it must not hold the function open.
const TIMEOUT_MS = 4000;

/**
 * Fire the workflow. Never throws, never rejects.
 *
 * Deliberately NOT awaited at the call site in the sense that matters: the
 * caller may await it, but it resolves fast and swallows everything, so a
 * failure is invisible to the page being published.
 */
export async function requestThumbnail(slug) {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) {
    // Not an error. The scheduled run still covers this page within three
    // hours, which is exactly the behaviour before this existed.
    console.log('[thumbjob] no GITHUB_DISPATCH_TOKEN; leaving', slug, 'to the schedule');
    return false;
  }

  const url = 'https://api.github.com/repos/' + OWNER + '/' + REPO +
    '/actions/workflows/' + WORKFLOW + '/dispatches';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        // GitHub rejects an API request with no User-Agent.
        'User-Agent': 'ainetscape-thumbnails'
      },
      body: JSON.stringify({ ref: REF }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    // 204 No Content is success for this endpoint.
    if (res.status === 204) {
      console.log('[thumbjob] dispatched for', slug);
      return true;
    }
    // The body is GitHub's, not a user's, and naming the status is what makes
    // a bad token distinguishable from a renamed workflow in the logs.
    console.error('[thumbjob] dispatch returned', res.status, 'for', slug);
    return false;
  } catch (err) {
    console.error('[thumbjob] dispatch failed for', slug + ':', err && err.message);
    return false;
  }
}
