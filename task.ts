import type { Static, TSchema } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Event } from '@tak-ps/etl';
import { Feature } from '@tak-ps/node-cot'
import ETL, { SchemaType, handler as internal, local, DataFlowType, InvocationType, fetch } from '@tak-ps/etl';

/**
 * The Input Schema contains the environment object that will be requested via the CloudTAK UI
 * It should be a valid TypeBox object - https://github.com/sinclairzx81/typebox
 */
const InputSchema = Type.Object({
    'BoundingBox': Type.String({
        default: '-109.06,36.99,-102.04,41.00',
        description: 'Bounding box to limit gauges to a given area, formatted as "xmin,ymin,xmax,ymax" (West Longitude, South Latitude, East Longitude, North Latitude) in decimal degrees. Western longitudes are negative. Defaults to the state of Colorado.'
    }),
    'DEBUG': Type.Boolean({
        default: false,
        description: 'Print results in logs'
    })
});

/**
 * The Output Schema contains the known properties that will be returned on the
 * GeoJSON Feature in the .properties.metadata object
 */
const OutputSchema = Type.Object({
    lid: Type.String({ description: 'NWS Location ID (LID) of the gauge' }),
    name: Type.String({ description: 'Human readable gauge name' }),
    state: Type.Optional(Type.String({ description: 'State the gauge is located in' })),
    wfo: Type.Optional(Type.String({ description: 'NWS Weather Forecast Office responsible for the gauge' })),
    rfc: Type.Optional(Type.String({ description: 'NWS River Forecast Center responsible for the gauge' })),
    floodCategory: Type.String({ description: 'Observed NWS flood category (alarm state)' }),
    floodCategoryLabel: Type.String({ description: 'Human readable observed flood category' }),
    stageFt: Type.Optional(Type.Number({ description: 'Observed gage height in feet' })),
    flowCfs: Type.Optional(Type.Number({ description: 'Observed streamflow in cubic feet per second' })),
    observedAt: Type.Optional(Type.String({ description: 'Timestamp of the observed reading (UTC)' })),
    forecastCategory: Type.Optional(Type.String({ description: 'Forecast NWS flood category' })),
    usgsId: Type.Optional(Type.String({ description: 'USGS site number for this gauge' }))
})

/**
 * The NWS National Water Prediction Service (NWPS) publishes gauge observations that
 * originate from USGS instantaneous data alongside the NWS maintained flood category
 * (alarm state). Only the subset of fields used by this ETL are typed here - additional
 * response fields are stripped during validation.
 */
const GaugeStatus = Type.Object({
    primary: Type.Number(),
    primaryUnit: Type.String(),
    secondary: Type.Number(),
    secondaryUnit: Type.String(),
    floodCategory: Type.String(),
    validTime: Type.String()
});

const NamedCode = Type.Object({
    abbreviation: Type.String(),
    name: Type.String()
});

const Gauge = Type.Object({
    lid: Type.String(),
    name: Type.String(),
    rfc: Type.Optional(NamedCode),
    wfo: Type.Optional(NamedCode),
    state: Type.Optional(NamedCode),
    latitude: Type.Number(),
    longitude: Type.Number(),
    status: Type.Optional(Type.Object({
        observed: Type.Optional(GaugeStatus),
        forecast: Type.Optional(GaugeStatus)
    }))
});

const GaugesResponse = Type.Object({
    gauges: Type.Array(Gauge)
});

const GaugeDetail = Type.Object({
    lid: Type.String(),
    usgsId: Type.Optional(Type.String())
});

/**
 * NWS flood categories mapped to a human readable label and a marker color.
 * Colors match the National Water Prediction Service map legend at https://water.noaa.gov/
 */
const FLOOD_CATEGORIES: Record<string, { label: string; color: string }> = {
    major:       { label: 'Major Flooding',    color: '#B243B1' },
    moderate:    { label: 'Moderate Flooding', color: '#D94B4A' },
    minor:       { label: 'Minor Flooding',    color: '#F5A623' },
    action:      { label: 'Action Stage',      color: '#FFDE63' },
    no_flooding: { label: 'No Flooding',       color: '#98E09A' }
};

const DEFAULT_CATEGORY = { label: 'No Current Data', color: '#CCCCCC' };

// NWPS uses -999 as a sentinel value for missing readings
const NO_DATA = -998;

export default class Task extends ETL {
    static name = 'etl-usgs-gauges'
    static flow = [ DataFlowType.Incoming ];
    static invocation = [ InvocationType.Schedule ];

    async schema(
        type: SchemaType = SchemaType.Input,
        flow: DataFlowType = DataFlowType.Incoming
    ): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) {
                return InputSchema;
            } else {
                return OutputSchema;
            }
        } else {
            return Type.Object({});
        }
    }

    async control(): Promise<void> {
        const env = await this.env(InputSchema);

        const bbox = env.BoundingBox.split(',').map((coord) => Number(coord.trim()));
        if (bbox.length !== 4 || bbox.some((coord) => !Number.isFinite(coord))) {
            throw new Error(`Invalid BoundingBox "${env.BoundingBox}" - expected "xmin,ymin,xmax,ymax" in decimal degrees`);
        }

        const [xmin, ymin, xmax, ymax] = bbox;

        const url = new URL('https://api.water.noaa.gov/nwps/v1/gauges');
        url.searchParams.append('bbox.xmin', String(xmin));
        url.searchParams.append('bbox.ymin', String(ymin));
        url.searchParams.append('bbox.xmax', String(xmax));
        url.searchParams.append('bbox.ymax', String(ymax));
        url.searchParams.append('srid', 'EPSG_4326');

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'CloudTAK-ETL-USGS-Gauges (nicholas.ingalls@state.co.us)'
            }
        });

        const body = await res.typed(GaugesResponse);

        const detailMap = new Map<string, string | undefined>();
        await Promise.all(body.gauges.map(async (gauge) => {
            try {
                const detailRes = await fetch(new URL(`https://api.water.noaa.gov/nwps/v1/gauges/${gauge.lid}`), {
                    headers: {
                        'User-Agent': 'CloudTAK-ETL-USGS-Gauges (nicholas.ingalls@state.co.us)'
                    }
                });
                const detail = await detailRes.typed(GaugeDetail);
                detailMap.set(gauge.lid, detail.usgsId);
            } catch {
                detailMap.set(gauge.lid, undefined);
            }
        }));

        const features: Static<typeof Feature.InputFeature>[] = [];

        for (const gauge of body.gauges) {
            const observed = gauge.status && gauge.status.observed;

            let stageFt: number | undefined;
            let flowCfs: number | undefined;

            if (observed) {
                const readings: Array<{ value: number; unit: string }> = [
                    { value: observed.primary, unit: observed.primaryUnit },
                    { value: observed.secondary, unit: observed.secondaryUnit }
                ];

                for (const reading of readings) {
                    if (reading.value <= NO_DATA) continue;
                    if (reading.unit === 'ft') {
                        stageFt = reading.value;
                    } else if (reading.unit === 'kcfs') {
                        flowCfs = reading.value * 1000;
                    }
                }
            }

            const category = observed ? observed.floodCategory : '';
            const style = FLOOD_CATEGORIES[category] || DEFAULT_CATEGORY;

            const hasObservedTime = Boolean(observed && observed.validTime && !observed.validTime.startsWith('0001'));

            const usgsId = detailMap.get(gauge.lid);
            const nwsUrl = `https://water.noaa.gov/gauges/${gauge.lid}`;
            const usgsUrl = usgsId ? `https://waterdata.usgs.gov/monitoring-location/${usgsId}/` : undefined;

            const remarks = [
                gauge.name,
                `NWS Location ID: ${gauge.lid}`,
                `Alarm State: ${style.label}`,
                stageFt !== undefined ? `Gage Height: ${stageFt.toFixed(2)} ft` : null,
                flowCfs !== undefined ? `Streamflow: ${flowCfs.toFixed(1)} cfs` : null,
                hasObservedTime && observed ? `Observed: ${observed.validTime}` : null,
                gauge.wfo ? `Forecast Office: ${gauge.wfo.name} (${gauge.wfo.abbreviation})` : null
            ].filter((line) => line !== null).join('\n');

            const metadata: Static<typeof OutputSchema> = {
                lid: gauge.lid,
                name: gauge.name,
                floodCategory: category || 'unknown',
                floodCategoryLabel: style.label,
                state: gauge.state ? gauge.state.name : undefined,
                wfo: gauge.wfo ? gauge.wfo.abbreviation : undefined,
                rfc: gauge.rfc ? gauge.rfc.abbreviation : undefined,
                stageFt,
                flowCfs,
                observedAt: hasObservedTime && observed ? observed.validTime : undefined,
                forecastCategory: gauge.status && gauge.status.forecast ? gauge.status.forecast.floodCategory : undefined,
                usgsId
            };

            const links: Array<{ url: string; remarks: string; relation: string; mime: string }> = [
                { url: nwsUrl, remarks: 'NWS Prediction', relation: 'r-u', mime: 'text/html' },
                ...(usgsUrl ? [{ url: usgsUrl, remarks: 'USGS Gauge', relation: 'r-u', mime: 'text/html' }] : [])
            ];

            features.push({
                id: `nwps-${gauge.lid}`,
                type: 'Feature',
                properties: {
                    callsign: gauge.name,
                    type: 'a-f-G-E-S',
                    'marker-color': style.color,
                    // Expire features 6 hours after each run so stale gauges drop off the map
                    stale: 6 * 60 * 60 * 1000,
                    remarks,
                    links,
                    metadata
                },
                geometry: {
                    type: 'Point',
                    coordinates: [gauge.longitude, gauge.latitude]
                }
            });
        }

        const fc: Static<typeof Feature.InputFeatureCollection> = {
            type: 'FeatureCollection',
            features: features
        }

        if (env.DEBUG) {
            console.log(`ok - submitting ${features.length} gauge(s) within bbox ${env.BoundingBox}`);
            console.log(JSON.stringify(fc));
        }

        await this.submit(fc);
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}

