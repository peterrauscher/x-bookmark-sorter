// TypeSafe / Jev API client.
//
// Uses the TypeSafe HTTP API directly (https://api.typesafe.ai/v1/systemone)
// so the extension stays dependency-free. Each request carries a batch of
// bookmark states and one narrow Choice question per bookmark.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * Ask Jev which folder each bookmarked post belongs in.
 *
 * @param {string} apiKey  TypeSafe API key (from console.typesafe.ai)
 * @param {Array<object>} bookmarks  Bookmark records
 * @param {Array<{id:string,name:string}>} folders  X bookmark folders from the page
 * @param {string} model  e.g. "jev-latest"
 * @returns {Promise<Array<{bookmarkId:string, choice:string, confidence:number, probabilities:object}>>}
 */
export async function classifyBookmarks(apiKey, bookmarks, folders, model = 'jev-latest') {
  if (!bookmarks.length) return [];

  const criteria = {};
  for (const f of folders) {
    // Folder names are the whole criterion — no authored descriptions.
    criteria[f.id] = f.name;
  }
  // No-match outcome: the model can say nothing fits instead of forcing one.
  criteria.unsorted = 'The post does not clearly fit into any of the folders above.';

  const state = {
    bookmarks: bookmarks.map((bookmark, index) => {
      const item = {
        index,
        id: bookmark.id,
        author: bookmark.authorName && bookmark.authorHandle
          ? `${bookmark.authorName} (${bookmark.authorHandle})`
          : bookmark.authorName || bookmark.authorHandle || 'unknown',
        text: bookmark.text || '(no text — image/video post)',
        url: bookmark.url,
      };
      if (bookmark.replyTo) {
        item.replyTo = bookmark.replyTo;
      }
      if (bookmark.quote) {
        const q = bookmark.quote;
        const qAuthor = q.authorName && q.authorHandle
          ? `${q.authorName} (${q.authorHandle})`
          : q.authorName || q.authorHandle || '';
        item.quote = {
          ...(qAuthor ? { author: qAuthor } : {}),
          text: q.text || '',
        };
      }
      if (bookmark.linkCard) {
        const card = bookmark.linkCard;
        item.linkCard = {
          ...(card.title ? { title: card.title } : {}),
          ...(card.domain ? { domain: card.domain } : {}),
          ...(card.description ? { description: card.description } : {}),
        };
      }
      return item;
    }),
  };

  const questions = {};
  for (let i = 0; i < bookmarks.length; i++) {
    questions[`bookmark_${i}`] = {
      type: 'choice',
      instructions: `Which folder should the bookmarked X post at \`bookmarks[${i}]\` be filed into? Consider the post text and any attached thread context (reply target, quoted post, or article/link card). Choose the single best fit for that post only. Ignore all other posts in the state.`,
      criteria,
    };
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      state,
      questions,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TypeSafe API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.answers) throw new Error('Unexpected TypeSafe response shape');

  return bookmarks.map((bookmark, index) => {
    const answer = data.answers[`bookmark_${index}`];
    if (!answer || typeof answer.choice !== 'string') {
      throw new Error(`Unexpected TypeSafe response shape for bookmark_${index}`);
    }
    return {
      bookmarkId: bookmark.id,
      choice: answer.choice,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : 0,
      probabilities: answer.probabilities || {},
    };
  });
}
