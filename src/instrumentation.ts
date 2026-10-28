/**
 * Instrumentation hook: runs once when the Next.js server starts.
 *
 * Used to fail fast on a misconfigured environment rather than letting the app
 * come up and behave confusingly (for example a dev server pointed at the test
 * database that integration tests truncate).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertEnvironment } = await import("@/lib/env");

  try {
    assertEnvironment();
  } catch (error) {
    console.error(
      "[startup] Environment is not usable:\n" +
        (error instanceof Error ? error.message : String(error)),
    );
    // Do not swallow this: a server that cannot trust its configuration should
    // not serve requests.
    throw error;
  }
}
