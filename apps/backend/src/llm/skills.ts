import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * App-shipped skill templates, resolved from the compiled backend (`dist/llm` → `assets/skills`).
 *
 * These are templates, not the runtime location: `installBundledSkills()` copies them into
 * `<configDir>/skills` so the user can inspect and edit the installed skill.
 */
export const BUNDLED_SKILLS_ASSET_PATH = join(__dirname, '../../assets/skills');

/**
 * Copies each bundled skill into the user config root when it is not installed yet.
 *
 * Installation is intentionally non-destructive: an existing `SKILL.md` means the user owns that
 * skill (possibly edited), so the whole directory is left alone. A missing `SKILL.md` is treated as
 * an incomplete install and filled from the template. This keeps app updates from silently
 * overwriting user changes while still making a new install usable on first run.
 */
export function installBundledSkills(
  sourceRoot: string,
  targetRoot: string,
): void {
  if (!existsSync(sourceRoot)) return;

  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDirectory = join(sourceRoot, entry.name);
    const targetDirectory = join(targetRoot, entry.name);
    if (existsSync(join(targetDirectory, 'SKILL.md'))) continue;
    cpSync(sourceDirectory, targetDirectory, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
}
