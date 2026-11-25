/**
 * The floating panel, as an actual dialog.
 *
 * Every panel in the app is visually a dialog — it floats over the trace, has a
 * title and a close button, and Escape dismisses it — but until G16 it was a
 * `<div>`: a screen reader announced its heading as ordinary content, Tab walked
 * straight out of it into the rail behind, and closing it dropped focus on
 * `<body>`, so a keyboard reader had to start again from the top of the page.
 *
 * Those three failures are what `role="dialog"` + `aria-modal` + a focus trap +
 * focus restore fix, and they are the same three in all five panels, which is
 * why this is one component rather than five edits.
 *
 * What this deliberately does not do:
 *
 * - It does not own Escape. `App` does, on `window`, because the same handler
 *   also has to work when focus is on the canvas rather than in a panel; a
 *   second listener here would close twice.
 * - It does not set `aria-hidden` on the rest of the page. `aria-modal` is the
 *   declaration that the background is inert; hiding siblings by hand means
 *   tracking every sibling and undoing it in the right order, and a stale
 *   `aria-hidden` on the app root hides the whole app from the accessibility
 *   tree on the next panel.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { XIcon } from "./icons";
import { useT } from "../lib/i18n";

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), " +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  /** Already translated; the dialog names itself with it. */
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  /** Positioning and width: `right-4 top-20 w-[340px]` and so on. */
  className: string;
  /** Padding and layout for the body, which differs per panel. */
  bodyClassName?: string;
  /** Header padding, which was `p-4` in some panels and `px-4 pt-4 pb-3` in others. */
  headerClassName?: string;
  children: ReactNode;
  /** For the smoke test, which drives panels by kind rather than by position. */
  testId?: string;
}

export function Panel({
  title,
  icon,
  onClose,
  className,
  bodyClassName = "",
  headerClassName = "px-4 pt-4 pb-3",
  children,
  testId,
}: Props) {
  const { t } = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Remember what had focus so closing can put it back. Without this a
    // keyboard reader who opens Vitals with Enter lands on `<body>` on close
    // and has to tab through the whole page to return to the rail.
    const opener = document.activeElement as HTMLElement | null;
    // Focus the dialog itself, not its first control: the screen reader then
    // hears the title, and the reader decides whether to go in.
    ref.current?.focus();
    return () => {
      // `isConnected` guards the case where the opener was unmounted while the
      // panel was open (switching segments rebuilds parts of the rail).
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    // The container itself is a tab stop (tabIndex -1) so that Shift+Tab from
    // nowhere lands on the last control rather than escaping.
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-panel={testId}
      onKeyDown={onKeyDown}
      className={`${className} panel outline-none`}
    >
      <div className={`flex items-center justify-between shrink-0 ${headerClassName}`}>
        <h3 className="panel-title" id={titleId}>
          {icon}
          {title}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="icon-btn w-7 h-7"
          aria-label={t("Close")}
        >
          <XIcon size={16} />
        </button>
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
