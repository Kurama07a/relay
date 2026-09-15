import { config } from "./config.js";

/**
 * Time slabs: what a closed piece of work is logged as, for the client and the
 * sheet. Coarse on purpose — tracking is never precise, and a slab reads as an
 * honest figure rather than a timesheet line to argue with. The exact seconds
 * always stay in the ledger.
 *
 * With the default settings: under 5 minutes logs nothing, under 20 minutes is
 * half an hour, and from there it's whole hours, moving up once work runs 20
 * minutes past the hour.
 */
export function slabSeconds(exactSeconds: number): number {
  const minutes = exactSeconds / 60;
  const { floorMinutes, halfHourUnderMinutes, graceMinutes } = config.slabs;

  if (minutes < floorMinutes) return 0;
  if (minutes < halfHourUnderMinutes) return 30 * 60;
  return Math.max(1, Math.floor((minutes - graceMinutes) / 60) + 1) * 3600;
}

/** `30m`, `1h`, `7h 30m`. Slabs are half hours at their finest. */
export function formatSlab(seconds: number): string {
  const halfHours = Math.round(seconds / 1800);
  if (halfHours === 0) return "0h";
  const hours = Math.floor(halfHours / 2);
  if (hours === 0) return "30m";
  return halfHours % 2 === 1 ? `${hours}h 30m` : `${hours}h`;
}

/** Past this, one unit of work is probably several and worth splitting. */
export function needsSplitting(exactSeconds: number): boolean {
  return exactSeconds >= config.slabs.splitWarningHours * 3600;
}
