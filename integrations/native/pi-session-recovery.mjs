const samples=Object.freeze(['direct-answer-no-tool','same-session-follow-up','legal-non-read-tool']);
/** Real Pi session bytes are not in this checkout. Additional shapes stay closed. */
export function requiredPiOfflineSamples(){return [...samples];}
export function admitPiSessionBeyondSyntheticProtocol(facts){
 if(facts!==undefined)throw Error('PI_SESSION_SCHEMA_UNCONFIRMED');
 return Object.freeze({admitted:false,reason:'pi_offline_schema_unconfirmed',samples:requiredPiOfflineSamples()});
}
