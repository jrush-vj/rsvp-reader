import { memo, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { Boundary } from "../lib/types";
import type { Word } from "../lib/words";

interface Paragraph {
  start: number;
  words: Word[];
  heading?: string;
}

interface Props {
  words: Word[];
  boundaries: Boundary[];
  index: number;
  onSeek: (index: number) => void;
}

interface ParagraphViewProps {
  paragraph: Paragraph;
  index: number;
  active: boolean;
  activeRef: RefObject<HTMLParagraphElement> | null;
}

const PARAGRAPH_LIMIT = 72;

function progressState(paragraph: Paragraph, index: number): number {
  if (index >= paragraph.start + paragraph.words.length) return 2;
  if (index < paragraph.start) return 0;
  return 1;
}

const EbookParagraph = memo(
  function EbookParagraph({ paragraph, index, active, activeRef }: ParagraphViewProps) {
    return (
      <p
        className="ebook__paragraph"
        ref={active ? activeRef : undefined}
      >
        {paragraph.words.map((word, offset) => {
          const wordIndex = paragraph.start + offset;
          return (
            <span
              key={wordIndex}
              className={[
                "ebook__word",
                wordIndex < index ? "is-covered" : "",
                wordIndex === index ? "is-current" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-word-index={wordIndex}
            >
              {offset > 0 ? " " : null}
              {word.text}
            </span>
          );
        })}
      </p>
    );
  },
  (previous, next) =>
    previous.paragraph === next.paragraph &&
    previous.active === next.active &&
    (!next.active || previous.index === next.index) &&
    progressState(previous.paragraph, previous.index) ===
      progressState(next.paragraph, next.index),
);

function makeParagraphs(words: Word[], boundaries: Boundary[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let boundaryIndex = 0;
  let paragraphStart = 0;
  let paragraphWords: Word[] = [];

  const flush = (heading?: string) => {
    if (paragraphWords.length) {
      paragraphs.push({ start: paragraphStart, words: paragraphWords, heading });
      paragraphWords = [];
    }
    paragraphStart = paragraphs.length ? paragraphs[paragraphs.length - 1].start + paragraphs[paragraphs.length - 1].words.length : 0;
  };

  words.forEach((word, index) => {
    const boundary = boundaries[boundaryIndex];
    if (boundary && boundary.start_index === index) {
      flush();
      paragraphStart = index;
      boundaryIndex += 1;
      if (boundary.title || boundary.full_title) {
        paragraphs.push({ start: index, words: [], heading: boundary.title || boundary.full_title || "" });
      }
    }

    if (!paragraphWords.length) paragraphStart = index;
    paragraphWords.push(word);
    const sentenceEnded = /[.!?][\"'”’)]*$/.test(word.text);
    if (sentenceEnded || paragraphWords.length >= PARAGRAPH_LIMIT) flush();
  });
  flush();
  return paragraphs;
}

export function EbookReader({ words, boundaries, index, onSeek }: Props) {
  const activeParagraph = useRef<HTMLParagraphElement | null>(null);
  const paragraphs = useMemo(() => makeParagraphs(words, boundaries), [words, boundaries]);
  const activeStart = useMemo(() => {
    let result = 0;
    for (const paragraph of paragraphs) {
      if (paragraph.words.length && paragraph.start <= index) result = paragraph.start;
    }
    return result;
  }, [paragraphs, index]);

  useEffect(() => {
    const node = activeParagraph.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    if (bounds.top < 100 || bounds.bottom > window.innerHeight - 180) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeStart]);

  return (
    <article
      className="ebook"
      aria-label="Book text. Use the reader controls or keyboard shortcuts to navigate. Click a word to resume there."
      data-ebook-content
      tabIndex={0}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const word = target.closest<HTMLElement>("[data-word-index]");
        const wordIndex = Number(word?.dataset.wordIndex);
        if (Number.isInteger(wordIndex)) onSeek(wordIndex);
        event.stopPropagation();
      }}
    >
      <div className="ebook__page">
        {paragraphs.map((paragraph, paragraphIndex) => {
          if (paragraph.heading) {
            return (
              <h2 className="ebook__heading" key={`heading-${paragraph.start}-${paragraphIndex}`}>
                {paragraph.heading}
              </h2>
            );
          }
          return (
            <EbookParagraph
              key={`paragraph-${paragraph.start}-${paragraphIndex}`}
              paragraph={paragraph}
              index={index}
              active={paragraph.start === activeStart}
              activeRef={activeParagraph}
            />
          );
        })}
      </div>
    </article>
  );
}
