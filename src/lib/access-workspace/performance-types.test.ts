import {expect,it} from 'vitest';
import {performanceTypeHints} from './performance-types';
const classes={FileResource:[],URIResource:[],CeTask:[]},children={FileResource:['FileResource','URIResource']};
const hints=(Comparison:string,Right:unknown)=>performanceTypeHints({Left:'resource.type',Comparison,Right},classes,children);
it('samples assignable subclasses from live metadata and keeps ExactTypeOf exact',()=>{
 expect(hints('Equal','FileResource')).toEqual(['FileResource','URIResource']);
 expect(hints('~',['FileResource'])).toEqual(['FileResource','URIResource']);
 expect(hints('ExactTypeOf','FileResource')).toEqual(['FileResource']);
 expect(hints('ExactTypeOf',['FileResource'])).toEqual([]);
 expect(hints('Contains','FileResource')).toEqual([]);
 expect(hints('ContainsAll',['FileResource','URIResource'])).toEqual(['URIResource']);
 expect(hints('ContainsAll',['FileResource','CeTask'])).toEqual([]);
 expect(hints('NotEqual','FileResource')).toEqual([]);
});
