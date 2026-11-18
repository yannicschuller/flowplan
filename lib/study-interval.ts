// The interval of a rating in the focus mode (components/study/focus-core.tsx):
// short under the button ("10 Min", "1 Tag", "10 Tage", "3 Mon.") and long
// for screen readers ("in 10 Tagen"). Days are written out, the rarer
// months and years abbreviated so "10 Tage" and "1,5 Mon." fit a button on
// a phone. One spelling for every place in the focus mode (the wait
// screen's "Nächste Karte in 6 Min" too).
import type { IntervalUnit } from "./fsrs";

type Translate = (de: string, en: string) => string;

export function intervalText(unit: IntervalUnit, value: number, format: (n: number) => string, t: Translate): { short: string; long: string } {
  const n = format(value);
  const one = value === 1;
  switch (unit) {
    case "now":
      return { short: t("< 1 Min", "< 1 min"), long: t("in weniger als einer Minute", "in less than a minute") };
    case "minutes":
      return { short: minutesText(value, format, t), long: one ? t("in 1 Minute", "in 1 minute") : t(`in ${n} Minuten`, `in ${n} minutes`) };
    case "hours":
      return { short: t(`${n} Std`, `${n} h`), long: one ? t("in 1 Stunde", "in 1 hour") : t(`in ${n} Stunden`, `in ${n} hours`) };
    case "days":
      return one ? { short: t("1 Tag", "1 day"), long: t("morgen", "tomorrow") } : { short: t(`${n} Tage`, `${n} days`), long: t(`in ${n} Tagen`, `in ${n} days`) };
    case "months":
      return { short: t(`${n} Mon.`, `${n} mo`), long: one ? t("in 1 Monat", "in 1 month") : t(`in ${n} Monaten`, `in ${n} months`) };
    default:
      return { short: one ? t("1 Jahr", "1 year") : t(`${n} Jahre`, `${n} years`), long: one ? t("in 1 Jahr", "in 1 year") : t(`in ${n} Jahren`, `in ${n} years`) };
  }
}

// Minutes as on the buttons ("6 Min"): the wait screen and the summary.
export function minutesText(value: number, format: (n: number) => string, t: Translate) {
  const n = format(value);
  return t(`${n} Min`, `${n} min`);
}
