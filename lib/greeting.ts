/** Time-of-day greeting with the first name, or null when there is no name. */
export function greetingFor(
  name: string | null | undefined,
  now: Date,
  timeZone = "Asia/Manila",
): string | null {
  const firstName = name?.trim().split(/\s+/)[0];
  if (!firstName) return null;

  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(now),
  );
  const part =
    hour >= 5 && hour <= 11
      ? "Good morning"
      : hour >= 12 && hour <= 17
        ? "Good afternoon"
        : "Good evening";
  return `${part}, ${firstName}`;
}
