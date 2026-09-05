export interface MonthWindow {
  from: string;
  to: string;
}

export function ukToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function monthWindows(
  startMonth = ukToday().slice(0, 7),
  count = 7,
): MonthWindow[] {
  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth) ||
    Number(startMonth.slice(0, 4)) < 1900 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 12
  ) {
    throw new Error("INVALID_SYNC_WINDOW");
  }
  const year = Number(startMonth.slice(0, 4));
  const month = Number(startMonth.slice(5));
  return Array.from({ length: count }, (_, i) => ({
    from: new Date(Date.UTC(year, month - 1 + i, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, month + i, 0)).toISOString().slice(0, 10),
  }));
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}
