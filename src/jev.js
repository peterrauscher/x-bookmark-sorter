// TypeSafe / Jev API client.
//
// Uses the TypeSafe HTTP API directly (https://api.typesafe.ai/v1/systemone)
// so the extension stays dependency-free. Follows the TypeSafe skill guidance:
// one narrow Choice question per bookmark, with the user's folders as criteria
// plus an explicit "unsorted" no-match option, and confidence-gated filing.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * Ask Jev which folder a bookmarked post belongs in.
 *
 * @param {string} apiKey  TypeSafe API key (from console.typesafe.ai)
 * @param {object} bookmark  { id, text, authorName, authorHandle, url }
 * @param {Array<{id:string,name:string,description:string}>} folders
 * @param {string} model  e.g. "jev-latest"
 * @returns {Promise<{folderId:string, confidence:number, probabilities:object}>}
 */
export async function classifyBookmark(apiKey, bookmark, folders, model = 'jev-latest') {
  const criteria = {};
  for (const f of folders) {
    criteria[f.id] = (f.description && f.description.trim()) || `Posts about ${f.name}`;
  }
  // No-match outcome: the model can say nothing fits instead of forcing one.
  criteria['unsorted'] = 'The post does not clearly fit into any of the folders above.';

  const state = {
    author: bookmark.authorName || bookmark.authorHandle || 'unknown',
    text: bookmark.text || '(no text — image/video post)',
    url: bookmark.url,
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      state,
      questions: {
        folder: {
          type: 'choice',
          instructions: 'Which folder should this bookmarked X post be filed into? Choose the single best fit.',
          criteria,
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TypeSafe API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const answer = data.answers && data.answers.folder;
  if (!answer || typeof answer.choice !== 'string') {
    throw new Error('Unexpected TypeSafe response shape');
  }
  return {
    folderId: answer.folderId || answer.choice,
    choice: answer.choice,
    confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
    probabilities: answer.probabilities || {},
  };
}

/** Cheap key check: one tiny Noul question. */
export async function testApiKey(apiKey, model = 'jev-latest') {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      state: 'ping',
      questions: {
        ping: { type: 'noul', instructions: 'Is this state the word "ping"?' },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TypeSafe API ${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}
