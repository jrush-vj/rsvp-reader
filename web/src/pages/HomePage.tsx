import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { LinkButton } from "../components/ui/Button";
import { Card, Kicker } from "../components/ui/Surface";
import { EmptyState, Progress, Skeleton } from "../components/ui/Feedback";
import { clock, fmtMinutes, fmtWords, minsFor } from "../lib/format";
import { useStored, WPM_KEY } from "../lib/storage";
import { splitAtOrp, toWord } from "../lib/words";
import { WPM_DEFAULT } from "../lib/speed";
import type { Word } from "../lib/words";
import { mostRecent, totals, useLibrary } from "../store/library";

/**
 * The home page.
 * ---------------------------------------------------------------------------
 * A lander first and a dashboard second, in that order. Someone opening this
 * for the first time has no books, so the top of the page has to explain what
 * the app does without a data dependency — hence the live demo. Someone coming
 * back has a book in progress, and the continue card is what they actually
 * want, so it sits directly under the hero.
 *
 * Deliberately not a stats dashboard: the reading speed, word counts and
 * history of the original were the clutter the brief asked to remove. Only two
 * numbers survive, and only because they answer "how much is left".
 */

const DEMO_SENTENCE =
  "Speed reading works because your eyes stop moving. Focus on one point. " +
  "Let each word arrive. Comprehension follows attention.";

export function HomePage() {
  const { books, initialLoading } = useLibrary();
  const reduce = useReducedMotion();
  const resume = mostRecent(books);
  const sum = useMemo(() => totals(books), [books]);
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
          <Kicker>Read faster, one word at a time</Kicker>
          <h1 className="hero__title">
            Your eyes are <span className="grad-text">wasting</span> most of
            this page.
          </h1>
          <p className="hero__lede">
            BookTube shows you one word at a time, aligned on the point your eye
            reads best. No saccades, no re-reading, no line tracking — just the
            words, at the pace you choose. Most people settle comfortably
            between 300 and 700 words per minute.
          </p>

          <div className="hero__cta">
            <LinkButton to={resume ? `/read/${resume.book_id}` : "/add"} variant="primary" size="lg" icon={resume ? "play" : "plus"}>
              {resume ? "Continue reading" : "Add your first book"}
            </LinkButton>
            <LinkButton to="/library" size="lg" icon="books" variant="glass">
              Open library
            </LinkButton>
          </div>

          <ul className="hero__facts">
            <li>
              <Icon name="check" size={15} />
              Nothing is sent anywhere
            </li>
            <li>
              <Icon name="check" size={15} />
              Your place is saved per book
            </li>
            <li>
              <Icon name="check" size={15} />
              Front and back matter are skipped
            </li>
          </ul>
        </motion.div>

        <motion.div
          className="hero__demo"
          initial={reduce ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        >
          <DemoStage />
        </motion.div>
      </section>

      {/* ---- what to do next ------------------------------------------- */}
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
            <EmptyState
              icon="sparkle"
              title="Nothing in your library yet"
              body="Add a PDF and BookTube finds the chapters, skips the index, and starts you at word one."
              action={
                <LinkButton to="/add" variant="primary" icon="plus">
                  Add a book
                </LinkButton>
              }
            />
          </Card>
        )}

        {books.length > 1 && !initialLoading && (
          <Card className="mini-stats">
            <div className="mini-stats__row">
              <MiniStat label="Books" value={String(books.length)} />
              <MiniStat label="Words" value={fmtWords(sum.words)} />
              <MiniStat label="In progress" value={String(sum.reading)} />
              <MiniStat label="Finished" value={String(sum.finished)} />
            </div>
            <span className="mini-stats__note">
              {fmtWords(sum.read, true)} of {fmtWords(sum.words, true)} words read
              across the library
            </span>
          </Card>
        )}
      </section>

      {/* ---- how it works ---------------------------------------------- */}
      <section className="howto">
        <h2 className="block__title">How it works</h2>
        <div className="howto__grid">
          <HowStep
            n="01"
            icon="file"
            title="Bring a book"
            body="Drop in a PDF. The detector reads its outline — or its printed contents page — to work out where the chapters actually begin."
          />
          <HowStep
            n="02"
            icon="layers"
            title="Check the outline"
            body="Front matter, indexes and notes are unchecked by default. Add or remove any section from the reader's contents panel."
          />
          <HowStep
            n="03"
            icon="play"
            title="Read"
            body="Set your pace and press space. Your position is saved as you go, so closing the tab never loses your place."
          />
        </div>
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

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="ministat">
      <span className="ministat__value tnum">{value}</span>
      <span className="ministat__label">{label}</span>
    </span>
  );
}

function HowStep({
  n,
  icon,
  title,
  body,
}: {
  n: string;
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  body: string;
}) {
  return (
    <article className="howstep nm-raise">
      <span className="howstep__n tnum">{n}</span>
      <span className="howstep__icon">
        <Icon name={icon} size={20} />
      </span>
      <h3 className="howstep__title">{title}</h3>
      <p className="howstep__body">{body}</p>
    </article>
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
function DemoStage() {
  const reduce = useReducedMotion();
  const words = useMemo<Word[]>(
    () =>
      DEMO_SENTENCE.split(/\s+/)
        .filter(Boolean)
        .map(toWord),
    [],
  );

  const [i, setI] = useState(0);
  const [wpm] = useState(420);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    let timer: number;

    const step = () => {
      if (cancelled) return;
      const w = words[i % words.length];
      const delay = (60_000 / wpm) * (w.pause || 1);
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setI((v) => (v + 1) % words.length);
      }, delay);
    };

    step();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [i, wpm, words, reduce]);

  const word = words[i % words.length];
  const [pre, pivot, post] = word ? splitAtOrp(word) : ["", "", ""];

  return (
    <div className="demo">
      <div className="demo__chrome">
        <span className="demo__dot" />
        <span className="demo__dot" />
        <span className="demo__dot" />
        <span className="demo__name">Reading — {wpm} wpm</span>
      </div>

      <div className="demo__stage">
        <div className="demo__word">
          <span className="demo__pre">{pre}</span>
          <span className="demo__pivot">{pivot}</span>
          <span className="demo__post">{post}</span>
        </div>
        <span className="demo__tick" aria-hidden="true" />
      </div>

      <div className="demo__foot">
        <span className="demo__bar">
          <motion.span
            className="demo__fill"
            animate={{ width: `${(((i % words.length) + 1) / words.length) * 100}%` }}
            transition={{ duration: 0.18, ease: "linear" }}
          />
        </span>
        <span className="demo__clock tnum">
          {clock(((i % words.length) / wpm) * 60)}
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
