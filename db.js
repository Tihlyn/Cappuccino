// ok so I copied and pasted a lot of this from stackoverflow to make category matching more robust
// some ai might have helped too
const Database = require("better-sqlite3");
const db = new Database("trivia.db");


db.prepare(`
    CREATE TABLE IF NOT EXISTS trivia_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        option1 TEXT NOT NULL,
        option2 TEXT NOT NULL,
        option3 TEXT NOT NULL,
        option4 TEXT NOT NULL,
        correct_index INTEGER NOT NULL
    )
`).run();

// Helpful index for faster category lookups
try {
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_trivia_category ON trivia_questions(category)`).run();
} catch (e) {
  // Non-fatal
  console.warn("[DB] Failed to create index idx_trivia_category", e);
}

function normalizeCategory(str = "") {
  return str
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function validateQuestion(q) {
    const allowedCategories = [
        "Entertainment: Film",
        "Entertainment: Music", 
        "Entertainment: Television",
        "Entertainment: Video Games",
        "Entertainment: Japanese Anime & Manga"
    ];
    if (!allowedCategories.includes(q.category)) {
        throw new Error(`Invalid category: ${q.category}. Allowed: ${allowedCategories.join(", ")}`);
    }
    if (!q.question || q.question.length < 5) {
        throw new Error("Question text is too short.");
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) {
        throw new Error("You must provide exactly 4 options.");
    }
    if (typeof q.correct_index !== "number" || q.correct_index < 0 || q.correct_index > 3) {
        throw new Error("Correct index must be 0-3.");
    }
}

function getQuestionsByCategoryRobust(category, limit = 10) {
  const attempts = [];
  let rows = [];
  let method = "none";
  let resolvedCategory = category;

  try {
    // 1. Exact match
    rows = db.prepare(`SELECT * FROM trivia_questions WHERE category = ? ORDER BY RANDOM() LIMIT ?`).all(category, limit);
    attempts.push({ method: "exact", count: rows.length });
    if (rows.length) { method = "exact"; return { questions: rows, resolvedCategory, method, attempts }; }

    // 2. Trimmed
    const trimmed = category.trim();
    if (trimmed !== category) {
      rows = db.prepare(`SELECT * FROM trivia_questions WHERE category = ? ORDER BY RANDOM() LIMIT ?`).all(trimmed, limit);
      attempts.push({ method: "trim", count: rows.length });
      if (rows.length) { method = "trim"; resolvedCategory = trimmed; return { questions: rows, resolvedCategory, method, attempts }; }
    }

    // 3. Case-insensitive exact
    rows = db.prepare(`SELECT * FROM trivia_questions WHERE lower(category) = lower(?) ORDER BY RANDOM() LIMIT ?`).all(category, limit);
    attempts.push({ method: "nocase", count: rows.length });
    if (rows.length) { method = "nocase"; resolvedCategory = rows[0].category; return { questions: rows, resolvedCategory, method, attempts }; }

    // 4. Normalized match against distinct categories
    const normTarget = normalizeCategory(category);
    const distinct = db.prepare(`SELECT DISTINCT category FROM trivia_questions`).all();
    let matched = null;
    for (const c of distinct) {
      if (normalizeCategory(c.category) === normTarget) { matched = c.category; break; }
    }
    if (matched) {
      rows = db.prepare(`SELECT * FROM trivia_questions WHERE category = ? ORDER BY RANDOM() LIMIT ?`).all(matched, limit);
      attempts.push({ method: "normalized", count: rows.length });
      if (rows.length) { method = "normalized"; resolvedCategory = matched; return { questions: rows, resolvedCategory, method, attempts }; }
    }

    // 5. Partial token search (last word or significant part)
    const tokens = category.split(/[:]/).pop().split(/\s+/).filter(Boolean); // take segment after last colon
    let searchToken = tokens.find(t => t.length > 3) || tokens[0] || category;
    searchToken = searchToken.replace(/[^a-z0-9]/gi, "");
    rows = db.prepare(`SELECT * FROM trivia_questions WHERE category LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY RANDOM() LIMIT ?`).all(searchToken, limit);
    attempts.push({ method: "partial", token: searchToken, count: rows.length });
    if (rows.length) { method = "partial"; resolvedCategory = rows[0].category; return { questions: rows, resolvedCategory, method, attempts }; }

    return { questions: [], resolvedCategory: category, method: "none", attempts };
  } catch (err) {
    return { questions: [], resolvedCategory: category, method: "error", error: err, attempts };
  }
}

function getDistinctCategories() {
  return db.prepare(`SELECT category, COUNT(*) as count FROM trivia_questions GROUP BY category ORDER BY count DESC`).all();
}

module.exports = {
    getQuestionsByCategory: (category, limit = 10) => {
        const rows = db.prepare(
            `SELECT * FROM trivia_questions WHERE category = ? ORDER BY RANDOM() LIMIT ?`
        ).all(category, limit);
        return rows;
    },
    getQuestionsByCategoryRobust,
    getDistinctCategories,
    addQuestion: (q) => {
        validateQuestion(q);
        db.prepare(
            `INSERT INTO trivia_questions (category, question, option1, option2, option3, option4, correct_index)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(q.category, q.question, q.options[0], q.options[1], q.options[2], q.options[3], q.correct_index);
    },
    getAllQuestions: () => {
        return db.prepare(`SELECT * FROM trivia_questions`).all();
    }
};
