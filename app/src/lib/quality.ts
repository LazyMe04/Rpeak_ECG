/**
 * The catalogue's signal-quality label, as something a reader can see.
 *
 * `pipeline/convert.py` stores one of five machine values per segment
 * (`ok`, `saturated`, `low-amplitude`, `flat`, `implausible-hr`). The panel
 * used to render that string straight into the UI, so a Vietnamese reader saw
 * "Chất lượng: low-amplitude" -- English, and hyphenated jargon at that.
 *
 * Two things live here rather than in the two components that show it, because
 * they had already drifted once: the *translation key* and the tone. The key is
 * the English sentence, like everywhere else, so an unknown value from a future
 * pipeline still renders the raw string rather than a blank.
 */

/** Machine value -> the English sentence that names it in the dictionary. */
export const QUALITY_LABEL: Record<string, string> = {
  ok: "Normal signal",
  saturated: "Saturated",
  "low-amplitude": "Low amplitude",
  flat: "Flat / disconnected",
  "implausible-hr": "Implausible heart rate",
};

/** The dictionary key for a stored value, falling back to the value itself. */
export function qualityLabel(quality: string | null | undefined): string {
  if (!quality) return "--";
  return QUALITY_LABEL[quality] ?? quality;
}

/**
 * Colour by how usable the segment is, matching the F1 tone scale beside it:
 * green is fine, yellow is usable with care, red is why the detector is wrong.
 */
export function qualityTone(quality: string | null | undefined): string {
  if (!quality) return "text-faint";
  if (quality === "ok") return "text-green-400";
  if (quality === "saturated" || quality === "low-amplitude") return "text-yellow-400";
  return "text-red-400";
}
