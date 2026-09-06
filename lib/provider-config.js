"use strict";

function buildMistralEnvironment(env = process.env) {
  return {
    ...env,
    HOST: env.MISTRAL_HOST || env.HOST || "127.0.0.1",
    PORT: env.MISTRAL_PORT || env.PORT || "3001",
    CDP_HOST: env.MISTRAL_CDP_HOST || env.CDP_HOST || "127.0.0.1",
    CDP_PORT: env.MISTRAL_CDP_PORT || "9223",
    DATA_DIR: env.MISTRAL_DATA_DIR || "data-mistral",
    PROFILE_DIR: env.MISTRAL_PROFILE_DIR || "chrome-profile",
    API_KEY: env.MISTRAL_API_KEY || env.API_KEY || "",
    ALLOWED_ORIGINS: env.MISTRAL_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || "",
    ALLOWED_HOSTS: env.MISTRAL_ALLOWED_HOSTS || env.ALLOWED_HOSTS || ""
  };
}

module.exports = { buildMistralEnvironment };
