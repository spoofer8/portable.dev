import fs from 'node:fs';
import path from 'node:path';

describe('@bacons/apple-targets prebuild patch', () => {
  it('keeps the configuration list reachable while replacing it', () => {
    const packagePath = require.resolve('@bacons/apple-targets/package.json');
    const pluginPath = path.join(path.dirname(packagePath), 'build', 'with-xcode-changes.js');
    const pluginSource = fs.readFileSync(pluginPath, 'utf8');

    expect(pluginSource).toContain(
      'const existingConfigurationList = targetToUpdate.props.buildConfigurationList;'
    );
    expect(pluginSource).toContain(
      '[...existingConfigurationList.props.buildConfigurations].forEach'
    );
    expect(pluginSource).toContain('existingConfigurationList.removeFromProject();');
    expect(pluginSource).not.toContain(
      'targetToUpdate.props.buildConfigurationList.removeFromProject();'
    );
  });
});
