import tinyCities from './tiny-cities.json';
import KDBush from 'kdbush';
import { around } from 'geokdbush';

const tree = new KDBush(tinyCities.length)
for (const { latitude, longitude } of tinyCities) {
    tree.add(longitude, latitude)
}
tree.finish()

export const findClosestCity = (lat: number, lon: number): string => {
    const results = around(tree, lon, lat, 1)

    if (results.length === 0) return "Unknown location"

    const idx = results[0] as number
    return `${tinyCities[idx].name}, ${tinyCities[idx].country_code}`
};
