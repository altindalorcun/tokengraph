const DATE_SUFFIX = /-\d{8}$/;

/** Drops the release-date suffix, which only tells snapshots of the same model apart. */
export function modelLabel(model: string): string {
  return model.replace(DATE_SUFFIX, '');
}
