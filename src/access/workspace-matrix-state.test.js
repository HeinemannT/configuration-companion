import { expect,it } from 'vitest';
import { stateAfterApply } from './workspace-state.js';
it('remaps the matrix context after apply and returns to the matrix when its role was deleted',()=>{
  const state={rid:'',tabs:[],tests:new Map(),testOpen:new Set(),matrixTesting:true,
    matrixTest:{role:'old',type:'CeTask'},matrix:{selected:{role:'old',type:'CeTask'},highlight:'old'}};
  const mapped=stateAfterApply(state,{roles:[{rid:'new'}]},{old:'new'});
  expect(mapped.matrixTest.role).toBe('new');expect(mapped.matrix.selected.role).toBe('new');
  const deleted=stateAfterApply(state,{roles:[]});
  expect(deleted.matrixTest).toBeNull();expect(deleted.matrix.selected).toBeNull();
  expect(deleted).toMatchObject({matrixShowing:true,matrixTesting:false,testing:false});
});
