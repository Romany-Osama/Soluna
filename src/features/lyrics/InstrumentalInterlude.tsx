/**
 * Instrumental interlude (behaviour studied from Liner as a design
 * reference; the animation is Soluna's own): a small animation for the
 * music-only parts — a whole instrumental track, or the intro before the
 * first line. Pure CSS (floating notes + pulsing bars), no new dependency.
 */
export function InstrumentalInterlude({ label }: { label: string }) {
  return (
    <div className="lyrics-interlude" role="status" aria-label={label}>
      <div className="lyrics-interlude-notes" aria-hidden="true">
        <span>♪</span>
        <span>♫</span>
        <span>♪</span>
        <span>♫</span>
        <span>♪</span>
      </div>
      <div className="lyrics-interlude-bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p>{label}</p>
    </div>
  );
}
