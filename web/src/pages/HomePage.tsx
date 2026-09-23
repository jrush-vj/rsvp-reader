import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { LinkButton } from "../components/ui/Button";
import { Card, Kicker } from "../components/ui/Surface";
import { Progress, Skeleton } from "../components/ui/Feedback";
import { clock, fmtMinutes, fmtWords, minsFor } from "../lib/format";
import { useStored, WPM_KEY } from "../lib/storage";
import { splitAtOrp, tokenize } from "../lib/words";
import { WPM_DEFAULT } from "../lib/speed";
import { mostRecent, useLibrary } from "../store/library";

/**
 * The home page.
 * ---------------------------------------------------------------------------
 * One-screen introduction, live demonstration, and a compact resume action.
 */

const DEMO_SENTENCE =
  "Read PDFs one word at a time at your own pace. Chapters are found for you, " +
  "and your place is saved automatically.";
const DEMO_WORDS = tokenize(DEMO_SENTENCE);
const DEMO_WPM = 420;

export function HomePage() {
  const { books, initialLoading } = useLibrary();
  const reduce = useReducedMotion();
  const resume = mostRecent(books);
  const [demoIndex, setDemoIndex] = useState(0);
  // The reader stores the chosen pace under this key. Reading it here is what
  // keeps the "time left" honest — a hardcoded default would tell a 375 wpm
  // reader they have an hour when they have two, and the two pages would
  // contradict each other in the same session.
  //
  // No subscription is needed: navigating to the reader unmounts this page, so
  // the value is re-read from localStorage on the way back. A `storage` event
  // listener would only cover a second tab, which is not worth the branch.
  const [wpm] = useStored<number>(WPM_KEY, WPM_DEFAULT);

  return (
    <div className="page page--home">
      <section className="hero">
        <motion.div
          className="hero__copy"
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        >
          <Kicker>A calmer way to read</Kicker>
          <h1 className="hero__title">
            Read more. <span className="grad-text">One word</span> at a time.
          </h1>
          <p className="hero__lede" aria-label={DEMO_SENTENCE}>
            {DEMO_WORDS.map((word, index) => (
              <span
                key={`${index}-${word.text}`}
                className={index === demoIndex ? "hero__lede-word is-reading" : "hero__lede-word"}
              >
                {word.text}
              </span>
            ))}
          </p>

          <div className="hero__cta">
            <LinkButton to={resume ? `/read/${resume.book_id}` : "/add"} variant="primary" size="lg" icon={resume ? "play" : "plus"}>
              {resume ? "Continue reading" : "Add your first book"}
            </LinkButton>
            <LinkButton to="/library" size="lg" icon="books" variant="glass">
              Open library
            </LinkButton>
          </div>

          <p className="hero__facts">Private by default · Chapters found · Auto-saved</p>
        </motion.div>

        <motion.div
          className="hero__demo"
          initial={reduce ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        >
          <DemoStage index={demoIndex} onWordChange={setDemoIndex} />
        </motion.div>
      </section>

      <section className="next">
        <h2 className="sr-only">Continue</h2>

        {initialLoading ? (
          <Card className="resume resume--loading">
            <Skeleton width={210} height={18} />
            <Skeleton width={320} height={12} />
            <Skeleton width="100%" height={6} radius={999} />
          </Card>
        ) : resume ? (
          <ResumeCard book={resume} wpm={wpm} />
        ) : (
          <Card className="resume">
            <div className="home-empty">
              <div>
                <Kicker>Your library is ready</Kicker>
                <p>Add your first PDF to begin.</p>
              </div>
              <LinkButton to="/add" variant="primary" icon="plus">
                Add a book
              </LinkButton>
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- resume */

function ResumeCard({
  book,
  wpm,
}: {
  book: NonNullable<ReturnType<typeof mostRecent>>;
  wpm: number;
}) {
  const pct = Math.max(0, Math.min(1, (book.percent || 0) / 100));
  const left = Math.max(0, (book.chosen_words || 0) - (book.word_index || 0));
  const mins = minsFor(left, wpm);

  return (
    <Card className="resume resume--live">
      <div className="resume__body">
        <div className="resume__head">
          <Kicker>{book.finished ? "Finished" : book.started ? "Continue reading" : "Up next"}</Kicker>
          <h3 className="resume__title" title={book.filename}>
            {book.filename.replace(/\.pdf$/i, "")}
          </h3>
        </div>

        <div className="resume__meter">
          <Progress value={pct} label={`${Math.round(pct * 100)} percent read`} />
          <div className="resume__meter-row">
            <span className="tnum">{Math.round(pct * 100)}%</span>
            <span className="dim">
              {fmtWords(book.word_index, true)} / {fmtWords(book.chosen_words, true)} words
            </span>
          </div>
        </div>

        {!book.finished && left > 0 && (
          <p className="resume__eta">
            <Icon name="clock" size={14} /> about {fmtMinutes(mins)} left at{" "}
            {wpm} wpm
          </p>
        )}
      </div>

      <div className="resume__side">
        <LinkButton to={`/read/${book.book_id}`} variant="primary" size="lg" icon="play">
          {book.started && !book.finished ? "Resume" : "Start"}
        </LinkButton>
        <Link to={`/library?focus=${book.book_id}`} className="resume__link">
          Details <Icon name="chevronRight" size={13} />
        </Link>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ demo */

/**
 * A live, self-driving demonstration of the reader.
 *
 * Runs the *real* timing rule against a real tokenised sentence, so the demo
 * cannot drift from the app — if the pivot index or the pause multiplier ever
 * change, this changes with them. Stops cleanly when the tab is hidden, so a
 * backgrounded home page is not silently burning a timer.
 */
function DemoStage({
  index,
  onWordChange,
}: {
  index: number;
  onWordChange: (index: number) => void;
}) {
  const reduce = useReducedMotion();
  const words = DEMO_WORDS;
  const wpm = DEMO_WPM;

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    let timer: number;

    const step = () => {
      if (cancelled) return;
      const w = words[index % words.length];
      const delay = (60_000 / wpm) * (w.pause || 1);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        onWordChange((index + 1) % words.length);
      }, delay);
    };

    step();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [index, onWordChange, reduce, words, wpm]);

  const word = words[index % words.length];
  const [pre, pivot, post] = word ? splitAtOrp(word) : ["", "", ""];
  return (
    <div className="demo">
      <div className="demo__chrome">
        <span className="demo__dot demo__dot--close" aria-hidden="true" />
        <span className="demo__dot demo__dot--minimize" aria-hidden="true" />
        <span className="demo__dot demo__dot--maximize" aria-hidden="true" />
        <span className="demo__name">Reading — {wpm} wpm</span>
      </div>

      <div className="demo__stage">
        <span className="demo__tick demo__tick--top" aria-hidden="true" />
        <span className="demo__tick demo__tick--bottom" aria-hidden="true" />
        <div className="demo__word">
          <span className="demo__pre">
            <span>{pre}</span>
          </span>
          <span className="demo__pivot">{pivot}</span>
          <span className="demo__post">
            <span>{post}</span>
          </span>
        </div>
        <span className="demo__wpm">{wpm} wpm</span>
      </div>

      <div className="demo__foot">
        <span className="demo__bar">
          <motion.span
            className="demo__fill"
            animate={{ width: `${(((index % words.length) + 1) / words.length) * 100}%` }}
            transition={{ duration: 0.18, ease: "linear" }}
          />
        </span>
        <span className="demo__clock tnum">
          {clock(((index % words.length) / wpm) * 60)}
        </span>
      </div>
    </div>
  );
}

/*
 * A default export alongside the name.
 *
 * The route table loads this module with `lazy()`, which can only take a
 * default. Keeping the named export as well costs nothing — it is the same
 * binding — and means the component can still be imported by name anywhere
 * that does not go through the router.
 */
export default HomePage;
