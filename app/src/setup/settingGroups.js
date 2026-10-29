/**
 * Installation settings per section of the installation page (Community
 * Edition). Kept apart from the routes so it can be read without opening
 * database or Redis connections. Other registry keys stay internal.
 */
export const SETTING_GROUPS = Object.freeze({
  ai: [
    'ai.enabled', 'ai.baseUrl', 'ai.apiKey', 'ai.chatModel', 'ai.fallbackModel', 'ai.classifierModel',
    'ai.embeddingModel', 'ai.embeddingBaseUrl', 'ai.embeddingApiKey',
    'ai.imageAnalysis', 'ai.visionModel', 'ai.speech', 'ai.ttsModel', 'ai.ttsVoice', 'ai.monthlyQuestionLimit'
  ],
  email: ['email.provider', 'email.from', 'email.smtpHost', 'email.smtpPort', 'email.smtpSecurity', 'email.smtpUser', 'email.smtpPassword', 'email.nuntlyApiKey'],
  features: ['nsfw.enabled', 'documents.parserEnabled', 'branding.poweredBy', 'updates.check'],
  integrations: ['pexels.apiKey', 'google.clientId', 'google.clientSecret', 'microsoft.clientId', 'microsoft.clientSecret']
});
