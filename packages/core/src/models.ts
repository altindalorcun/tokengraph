const DATE_SUFFIX = /(-\d{8}|-\d{4}-\d{2}-\d{2})$/;

/** Drops the release-date suffix (`-20251001` or `-2024-08-06`), which only tells snapshots of the same model apart. */
export function modelLabel(model: string): string {
  return model.replace(DATE_SUFFIX, '');
}
