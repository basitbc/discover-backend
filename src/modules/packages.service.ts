import { BaseService } from '../core/base.service.js';
import type { Row } from '../core/base.repository.js';
import { resolvePackageLists } from './package-lists.js';

/**
 * Packages are the one content type with real domain logic of its own, so they
 * get a service rather than using BaseService directly.
 *
 * This is the extension point the layering exists for: everything generic is
 * inherited, and only the genuinely package-specific rule is written here.
 */
export class PackageService extends BaseService {
  /**
   * Collapses raw per-package overrides and the global defaults into a single
   * ready-to-render `lists` object.
   *
   * Applied to PUBLIC reads only. The admin must keep seeing raw `listItems`,
   * because "this package has no items of this kind, so it inherits the
   * defaults" is exactly the state an editor needs to be able to see and
   * change — collapsing it there would hide which values are actually stored.
   */
  protected override async transformForPublic(row: Row): Promise<Row> {
    // super first: flattens the image relations, then the package-specific rule.
    return resolvePackageLists(await super.transformForPublic(row));
  }
}
