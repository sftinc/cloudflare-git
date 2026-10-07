export const NotFound = () => (
  <section class="message">
    <h1>Not found</h1>
    <p class="muted">There's nothing here, or you don't have access to it.</p>
    <p><a href="/">Back to repositories</a></p>
  </section>
);

export const StorageUnavailable = () => (
  <section class="message">
    <h1>Storage unavailable</h1>
    <p class="muted">The repository storage didn't respond. Try again in a moment.</p>
  </section>
);

export const ServerError = () => (
  <section class="message">
    <h1>Something went wrong</h1>
    <p class="muted">The error has been logged.</p>
  </section>
);

export const InviteInvalid = () => (
  <section class="message">
    <h1>This invite is no longer valid</h1>
    <p class="muted">Ask the person who sent it for a new link.</p>
  </section>
);
