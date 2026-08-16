export function withoutTaskboardEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("TASKBOARD_")),
  );
}
