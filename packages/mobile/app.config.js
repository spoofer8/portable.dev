module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_FILE?.trim();

  return {
    ...config,
    ios: {
      ...config.ios,
      googleServicesFile: googleServicesFile || config.ios?.googleServicesFile,
    },
  };
};
