import { Float64, Int32, Utf8, Dictionary, makeData, makeVector, vectorFromArray } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import { kindOfDuckType, vectorToCells, vectorToFloat64 } from '../src/renderer/src/core/arrow'

describe('vectorToFloat64', () => {
  it('returns the Arrow buffer itself for a null-free Float64 chunk', () => {
    const values = new Float64Array([1, 2, 3])
    const vec = makeVector(values)
    expect(vectorToFloat64(vec)).toBe(vec.data[0]!.values)
  })

  it('maps nulls to NaN, including in sliced and multi-chunk vectors', () => {
    const a = vectorFromArray([1, null, 3, 4, null, 6, 7, 8, 9, null], new Float64())
    expect(Array.from(vectorToFloat64(a))).toEqual([1, NaN, 3, 4, NaN, 6, 7, 8, 9, NaN])

    const sliced = a.slice(3, 10)
    expect(Array.from(vectorToFloat64(sliced))).toEqual([4, NaN, 6, 7, 8, 9, NaN])

    const b = vectorFromArray([null, 11], new Float64())
    const joined = sliced.concat(b)
    expect(joined.data.length).toBe(2)
    expect(Array.from(vectorToFloat64(joined))).toEqual([4, NaN, 6, 7, 8, 9, NaN, NaN, 11])
  })

  it('converts integer columns', () => {
    const v = makeVector(makeData({ type: new Int32(), data: new Int32Array([5, -2]) }))
    expect(Array.from(vectorToFloat64(v))).toEqual([5, -2])
  })
})

describe('vectorToCells', () => {
  it('handles dictionary strings and nulls', () => {
    const v = vectorFromArray(['a', null, 'b', 'a'], new Dictionary(new Utf8(), new Int32()))
    expect(vectorToCells(v)).toEqual(['a', null, 'b', 'a'])
  })
})

describe('kindOfDuckType', () => {
  it('classifies DuckDB types', () => {
    expect(kindOfDuckType('DOUBLE')).toBe('number')
    expect(kindOfDuckType('DECIMAL(18,3)')).toBe('number')
    expect(kindOfDuckType('TIMESTAMP WITH TIME ZONE')).toBe('time')
    expect(kindOfDuckType('TIMESTAMP_MS')).toBe('time')
    expect(kindOfDuckType('DATE')).toBe('time')
    expect(kindOfDuckType('VARCHAR')).toBe('string')
    expect(kindOfDuckType('BOOLEAN')).toBe('bool')
    expect(kindOfDuckType('INTERVAL')).toBe('other')
  })
})
