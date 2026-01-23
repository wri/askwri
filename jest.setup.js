import '@testing-library/jest-dom';

if (typeof global.structuredClone !== 'function') {
	global.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}
