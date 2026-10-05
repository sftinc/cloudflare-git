import { gitLoginCommand } from "../render/paths";

/** One command that saves the password in git's credential store, so git never prompts. */
export function GitSetup(props: { origin: string; password: string }) {
  const cmd = gitLoginCommand(props.origin, props.password);
  return (
    <div class="git-setup">
      <p><strong>Set up git on this computer.</strong> Run this once in a terminal (Git Bash on Windows). Git saves the password and won't ask for it again.</p>
      <pre><code>{cmd}</code></pre>
      <button type="button" class="btn" data-copy={cmd}>Copy command</button>
    </div>
  );
}
