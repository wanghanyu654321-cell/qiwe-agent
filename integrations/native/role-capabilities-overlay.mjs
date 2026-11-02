/** Candidate-only repair: Pi treats a resolved execute() as a successful tool. */
export function applyPiToolErrorBoundary(source) {
 const before='        return {\n          content: toPiContent(result),\n          details: result,\n        };';
 source=source.replaceAll('\r\n','\n');
 if(source.split(before).length!==2)throw Error('D4_PI_TOOL_ERROR_ANCHOR_CHANGED');
 return source.replace(before,`        if (result && typeof result === 'object' && 'isError' in result && result.isError === true) {
          const message = toPiContent(result).filter(item => item.type === 'text').map(item => item.text).join('\\n');
          throw new Error(message || 'MCP tool failed');
        }
${before}`);
}

export const d4OriginalHashes={
 'src/runtime/pi/pi-tools.ts':'99e4908dc7387f4bff8913414fd98f459eeed57458221c8c2c3f52fcc3bd51f1',
 'src/runtime/pi/pi-runtime.ts':'263f088aa901d46a0085dc66b24619b0ead9f481d8e183c75520e8edc1ac297a',
 'src/pi-index.ts':'94cebffd558f902d1ab881306d6ae3abb2d19c078c443d296632df8a7e201117',
 'node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js':'225053853f1a0bee80419001e24cb6676b43cb5cc8f111d60770641bff4370be',
 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js':'43cc779ddaf90df41768d3d2d0f7d7ba8b8bce7bedc9dc6062ca8b4de84ae880',
};
export const d4SkillHashes={
 'beauty-local-content':'792e944b9b96a7b592ff2f2f3b345f2644fd9711f8f0cc38de55a7aa0f83ccda',
 'vendor-content-strategy':'3abdf5b95e8b2d62adc34e42c2f0cb769ca8e62eff1e81f25d4c7dc9f3b2c832',
 'vendor-copywriting':'a5d08a728d96673dcf3cb1c706606f47cd24cf15cb9e1249856ca99798b2c545',
};
