/* PAPER WINGS - bounded reusable storage for projectiles, targets, and cues. */

function checkedCapacity(value){
  if(!Number.isInteger(value) || value < 1) throw new RangeError('capacity must be a positive integer');
  return value;
}

function checkedCallback(value, name){
  if(typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

export function createBoundedPool({
  capacity,
  create,
  activate = () => {},
  deactivate = () => {},
} = {}){
  const size = checkedCapacity(capacity);
  checkedCallback(create, 'create');
  checkedCallback(activate, 'activate');
  checkedCallback(deactivate, 'deactivate');

  const items = new Array(size);
  const indexByItem = new Map();
  const free = new Int32Array(size);
  const active = new Int32Array(size);
  const activePosition = new Int32Array(size);
  activePosition.fill(-1);
  let freeCount = size;
  let activeCount = 0;
  let iterating = false;

  for(let index = 0; index < size; index += 1){
    const item = create(index);
    if((typeof item !== 'object' && typeof item !== 'function') || item === null){
      throw new TypeError('create must return a unique object or function');
    }
    if(indexByItem.has(item)) throw new TypeError('create must return a unique item for every slot');
    items[index] = item;
    indexByItem.set(item, index);
    free[index] = size - index - 1;
  }

  function resolveIndex(itemOrIndex){
    if(Number.isInteger(itemOrIndex)) return itemOrIndex >= 0 && itemOrIndex < size ? itemOrIndex : -1;
    return indexByItem.get(itemOrIndex) ?? -1;
  }

  function acquire(payload){
    if(iterating) throw new Error('pool membership cannot change during forEachActive');
    if(freeCount === 0) return null;
    const index = free[--freeCount];
    active[activeCount] = index;
    activePosition[index] = activeCount;
    activeCount += 1;
    try {
      activate(items[index], payload, index);
    } catch(error){
      activeCount -= 1;
      activePosition[index] = -1;
      free[freeCount++] = index;
      throw error;
    }
    return items[index];
  }

  function release(itemOrIndex, reason = 'release'){
    if(iterating) throw new Error('pool membership cannot change during forEachActive');
    const index = resolveIndex(itemOrIndex);
    if(index < 0 || activePosition[index] < 0) return false;
    const position = activePosition[index];
    const lastPosition = activeCount - 1;
    const lastIndex = active[lastPosition];
    active[position] = lastIndex;
    activePosition[lastIndex] = position;
    activePosition[index] = -1;
    activeCount = lastPosition;
    free[freeCount++] = index;
    deactivate(items[index], reason, index);
    return true;
  }

  function forEachActive(callback, context = undefined){
    checkedCallback(callback, 'callback');
    if(iterating) throw new Error('pool iteration cannot be nested');
    iterating = true;
    try {
      for(let position = 0; position < activeCount; position += 1){
        const index = active[position];
        callback.call(context, items[index], index, position);
      }
    } finally {
      iterating = false;
    }
  }

  function drain(reason = 'drain'){
    while(activeCount > 0) release(active[activeCount - 1], reason);
  }

  function at(index){
    if(!Number.isInteger(index) || index < 0 || index >= size) return null;
    return items[index];
  }

  function isActive(itemOrIndex){
    const index = resolveIndex(itemOrIndex);
    return index >= 0 && activePosition[index] >= 0;
  }

  function diagnostics(){
    return Object.freeze({ capacity: size, active: activeCount, available: freeCount });
  }

  return Object.freeze({
    acquire,
    release,
    drain,
    forEachActive,
    at,
    isActive,
    diagnostics,
    get capacity(){ return size; },
    get activeCount(){ return activeCount; },
    get available(){ return freeCount; },
  });
}

export function createBoundedRing({ capacity, create, write, reset = () => {} } = {}){
  const size = checkedCapacity(capacity);
  checkedCallback(create, 'create');
  checkedCallback(write, 'write');
  checkedCallback(reset, 'reset');
  const entries = new Array(size);
  for(let index = 0; index < size; index += 1) entries[index] = create(index);
  let head = 0;
  let count = 0;

  function push(value){
    const index = count < size ? (head + count) % size : head;
    if(count < size) count += 1;
    else head = (head + 1) % size;
    write(entries[index], value, index);
    return entries[index];
  }

  function peek(offset = 0){
    if(!Number.isInteger(offset) || offset < 0 || offset >= count) return null;
    return entries[(head + offset) % size];
  }

  function shift(){
    if(count === 0) return null;
    const entry = entries[head];
    head = (head + 1) % size;
    count -= 1;
    return entry;
  }

  function consume(callback, context = undefined){
    checkedCallback(callback, 'callback');
    while(count > 0) callback.call(context, shift());
  }

  function clear(reason = 'clear'){
    while(count > 0){
      const entry = shift();
      reset(entry, reason);
    }
  }

  return Object.freeze({
    push,
    peek,
    shift,
    consume,
    clear,
    get capacity(){ return size; },
    get count(){ return count; },
  });
}
