import '@testing-library/jest-dom';
import structuredClonePolyfill from '@ungap/structured-clone';

if (typeof global.structuredClone !== 'function') {
	global.structuredClone = structuredClonePolyfill;
}
