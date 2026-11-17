export class NotFound extends Error {}

export class ServiceUnavailable extends Error {}
export class Conflict extends Error {}

/** Trusted host proof that no published-start creation effect was entered. */
export class PublishedStartRefused extends Conflict {}
