export class NotFound extends Error {}

export class ServiceUnavailable extends Error {}
export class Conflict extends Error {}

/** Host proof that scheduled input has not entered the worker and remains held. */
export class ScheduleInputHeld extends Error {}

/** Trusted host proof that no published-start creation effect was entered. */
export class PublishedStartRefused extends Conflict {}
