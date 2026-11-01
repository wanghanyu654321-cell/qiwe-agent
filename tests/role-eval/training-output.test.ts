import {it,expect} from 'vitest';import {isTrainingOutput} from '../../src/role-eval/training-output.js';
const id='source:L2-5',answer={answer:'合成教学建议',lesson:null,citations:[id],limitations:['待审核']};
it('question and lesson outputs remain distinct and require real source IDs',()=>{expect(isTrainingOutput(answer,'question',[id])).toBe(true);expect(isTrainingOutput({...answer,citations:['invented']},'question',[id])).toBe(false);expect(isTrainingOutput(answer,'lesson',[id])).toBe(false);});
it('a 45-minute lesson contains practice and assessment evidence without claiming training execution',()=>{
 const lesson={...answer,lesson:{title:'合成家访准备',goals:['会访谈'],steps:[{minutes:15,activity:'讲解',practice:'对练',evidence:'练习单'},{minutes:15,activity:'示范',practice:'角色扮演',evidence:'观察表'},{minutes:15,activity:'复盘',practice:'互评',evidence:'待审核记录'}],assessment:['提交练习单'],followUp:['次日店长复核']}};
 expect(isTrainingOutput(lesson,'lesson',[id])).toBe(true);expect(isTrainingOutput({...lesson,executed:true},'lesson',[id])).toBe(false);expect(isTrainingOutput({...lesson,lesson:{...lesson.lesson,steps:lesson.lesson.steps.slice(1)}},'lesson',[id])).toBe(false);
});
