const configureApp = require('../app.config');

const originalGoogleServicesFile = process.env.GOOGLE_SERVICES_FILE;

afterEach(() => {
  if (originalGoogleServicesFile === undefined) delete process.env.GOOGLE_SERVICES_FILE;
  else process.env.GOOGLE_SERVICES_FILE = originalGoogleServicesFile;
});

describe('dynamic Expo config', () => {
  const baseConfig = {
    name: 'Portable',
    slug: 'portable-mobile',
    ios: { googleServicesFile: './GoogleService-Info.plist' },
  };

  it('uses the local Firebase plist path when EAS did not provide a file secret', () => {
    delete process.env.GOOGLE_SERVICES_FILE;

    expect(configureApp({ config: baseConfig }).ios.googleServicesFile).toBe(
      './GoogleService-Info.plist'
    );
  });

  it('uses the EAS file-secret path when it is available', () => {
    process.env.GOOGLE_SERVICES_FILE = '/tmp/eas/GoogleService-Info.plist';

    expect(configureApp({ config: baseConfig }).ios.googleServicesFile).toBe(
      '/tmp/eas/GoogleService-Info.plist'
    );
  });
});
