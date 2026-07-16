/* LOW TIDE - fail-safe bridge between pointer ownership and reel state. */

export function cancelTideInput(action, sim){
  const result = action.cancel();
  if(sim.state.reelHeld) sim.setReeling(false);
  return result;
}
