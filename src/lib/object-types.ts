/**
 * The Ce* enterprise object types (the GRC template-instance layer: risks,
 * controls, issues, incidents, indicators, vendors, …). Blueprint's
 * description-view picker offers them.
 *
 * Derived from the live 5.6.10 type catalogue and kept static here: they are
 * stable platform types, not instance state.
 */

/** The 27 Ce* enterprise object types (idSpace TEMPLATECATEGORY). */
export const CE_TYPES: readonly string[] = [
  'CeAsset', 'CeAssuranceActivity', 'CeAttachment', 'CeComment',
  'CeComplianceRequirement', 'CeContract', 'CeControlMeasure', 'CeDistribution',
  'CeDPIA', 'CeIncident', 'CeIndicator', 'CeInquiry', 'CeIssue', 'CePolicy',
  'CePreScreening', 'CePrivacy', 'CeProcedure', 'CeProduct', 'CeProject',
  'CeQuestionnaire', 'CeRegulation', 'CeRiskAssessment', 'CeService', 'CeTask',
  'CeTIA', 'CeVendor', 'CeWorkflow',
];

