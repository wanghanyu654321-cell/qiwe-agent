// Applied only to the disposable local trial runner candidate. Never persists
// settings: the instance passed to the original createAgentSession is bounded.
export function disableControlledRealPiRetries(source){
 if(typeof source!=='string')throw Error('CONTROLLED_REAL_PI_RETRY_SOURCE_CHANGED');
 const eol=source.includes('\r\n')?'\r\n':'\n';
 const anchor=`    const settingsManager = SettingsManager.create(options.cwd, agentDir, {
      projectTrusted: true,
    });`.replaceAll('\n',eol);
 if(source.split(anchor).length!==2)throw Error('CONTROLLED_REAL_PI_RETRY_SOURCE_CHANGED');
 const guard=`
    const originalGetRetrySettings = settingsManager.getRetrySettings.bind(settingsManager);
    const originalGetProviderRetrySettings = settingsManager.getProviderRetrySettings.bind(settingsManager);
    settingsManager.getRetryEnabled = () => false;
    settingsManager.getRetrySettings = () => ({ ...originalGetRetrySettings(), enabled: false, maxRetries: 0 });
    settingsManager.getProviderRetrySettings = () => ({ ...originalGetProviderRetrySettings(), maxRetries: 0 });`.replaceAll('\n',eol);
 return source.replace(anchor,anchor+guard);
}
