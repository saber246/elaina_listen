(() => {
  const article = new Readability(document.cloneNode(true), {
    serializer: (content) => content,
  }).parse();

  if (!article?.content) {
    return { error: "未找到可朗读的正文。请打开文章详情页后再试。" };
  }

  const blockTags = new Set([
    "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT",
    "FIGCAPTION", "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR",
    "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL",
  ]);
  const ignoredTags = new Set(["NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);
  const paragraphs = [];
  let text = "";

  function finishParagraph() {
    const paragraph = text.replace(/\s+/g, " ").trim();
    if (paragraph) {
      paragraphs.push(paragraph);
    }
    text = "";
  }

  function collectText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || ignoredTags.has(node.tagName)
        || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") {
      return;
    }

    const startsNewBlock = blockTags.has(node.tagName);
    if (startsNewBlock) {
      finishParagraph();
    }
    for (const child of node.childNodes) {
      collectText(child);
    }
    if (startsNewBlock) {
      finishParagraph();
    }
  }

  collectText(article.content);
  finishParagraph();

  if (paragraphs.length === 0) {
    return { error: "未找到可朗读的正文。请打开文章详情页后再试。" };
  }

  const title = (article.title || document.title).trim() || "网页正文";
  if (paragraphs.length > 1 && paragraphs[0] === title) {
    paragraphs.shift();
  }

  return {
    title,
    source: location.hostname,
    url: location.href,
    language: article.lang || document.documentElement.lang,
    paragraphs,
  };
})();