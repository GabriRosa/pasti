import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTargets, sumMacros } from '../src/nutrition.js';
import { createDayPlan, mealAlternatives, swapMealFood } from '../src/planner.js';
import { getFood } from '../src/foods.js';
import { createEmptyData, exportBackup, parseBackup } from '../src/storage.js';
const profile = { age:35, weight:90, height:180, sex:'male', activity:'moderate', goal:'lose', trainingTime:'06:00', trainingDays:[1,3,5], specialCondition:false, nutritionTargets:{kcal:2200,protein:144,fat:80}, mealPlan:'chocolate-2200', routineNotes:'Allenamenti e preferenze di esempio.' };
const targets = calculateTargets(profile);
const meals = createDayPlan(profile, targets, '2026-10-26');
const close = (a,b,tolerance=1e-7) => assert.ok(Math.abs(a-b)<tolerance, `${a} vs ${b}`);

test('chosen targets remain distinct from TDEE and exact ingredient totals', () => {
  assert.equal(targets.kcal,2200); assert.equal(targets.protein,144); assert.equal(targets.fat,80); assert.equal(targets.carbs,226);
  assert.notEqual(targets.tdee-targets.kcal,500);
  const total=sumMacros(meals.map(x=>x.macros));
  close(total.kcal,2200.3); close(total.protein,144.075); close(total.fat,81.82); close(total.carbs,220.68);
  assert.equal(meals[0].time,'05:55'); assert.equal(meals[1].time,'07:00');
  assert.equal(meals[1].ingredients.find(x=>x.foodId==='skim-milk').grams,250);
  assert.equal(getFood('skim-milk').unit,'ml');
});

test('rest days preserve daily quantities and the single shaker without claiming a workout', () => {
  const rest=createDayPlan({...profile,trainingDays:[]},targets,'2026-10-26');
  assert.deepEqual(sumMacros(rest.map(x=>x.macros)),sumMacros(meals.map(x=>x.macros)));
  assert.match(rest[0].title,/spuntino/);
  assert.equal(rest.flatMap(x=>x.ingredients).filter(x=>x.foodId==='whey').length,1);
});

test('personal target validation rejects impossible macros, malformed objects and underweight deficits', () => {
  for(const nutritionTargets of [null,[],{kcal:2200,protein:NaN,fat:80},{kcal:500,protein:144,fat:80},{kcal:2200,protein:144,fat:80,extra:1}]) assert.throws(()=>calculateTargets({...profile,nutritionTargets}));
  assert.throws(()=>calculateTargets({...profile,weight:40,nutritionTargets:{kcal:1000,protein:60,fat:30}}));
  assert.throws(()=>calculateTargets({...profile,routineNotes:42}));
});

test('Milbona alternatives preserve one skim-milk shaker and approximately match breakfast energy and protein', () => {
  const alternatives=mealAlternatives(meals[1],targets);
  for(const id of ['protein-pudding-lidl','protein-pudding-lidl-vanilla','protein-mousse-lidl','protein-mousse-lidl-vanilla']) {
    const option=alternatives.find(x=>x.ingredients.some(i=>i.foodId===id)); assert.ok(option,id);
    close(option.macros.kcal,meals[1].macros.kcal,12); close(option.macros.protein,meals[1].macros.protein,1);
    assert.equal(option.ingredients.find(x=>x.foodId==='whey').grams,30);
    assert.equal(option.ingredients.find(x=>x.foodId==='skim-milk').grams,250);
    assert.ok(option.ingredients.some(x=>x.foodId==='chocolate-85'));
  }
});

test('all requested mains remain available and lentil pasta reduces the chicken portion', () => {
  const alternatives=mealAlternatives(meals[2],targets);
  for(const id of ['pasta','rice','couscous','potatoes','lentil-pasta-lidl','lentil-pasta-lidl-fresh','chicken','turkey','cod','eggs','egg-whites','salmon','tuna','pork-tenderloin']) assert.ok(alternatives.some(x=>x.ingredients.some(i=>i.foodId===id)),id);
  const changed=swapMealFood(meals[2],'pasta','lentil-pasta-lidl');
  assert.ok(changed.ingredients.find(x=>x.foodId==='chicken').grams<120);
  close(changed.macros.protein,meals[2].macros.protein,0.05);
  for(const option of alternatives) for(const number of Object.values(option.macros)) assert.ok(Number.isFinite(number));
});

test('chosen targets and routine survive backup without modifying historical snapshots', () => {
  const data=createEmptyData();data.profile=profile;
  data.days['2026-10-26']={dateKey:'2026-10-26',createdAt:'2026-10-26T08:00:00Z',updatedAt:'2026-10-26T08:00:00Z',profileSnapshot:structuredClone(profile),targets,meals,consumed:{},skipped:[]};
  const before=structuredClone(data.days);
  data.profile={...profile,nutritionTargets:{kcal:2400,protein:144,fat:80}};
  const restored=parseBackup(exportBackup(data));
  assert.deepEqual(restored.days,before); assert.equal(restored.profile.nutritionTargets.kcal,2400);
});
