<h1 align='center'>ETL-USGS-Gauges</h1>

<p align='center'>Import USGS stream gauge observations into CloudTAK, colored by NWS flood alarm state</p>

## Overview

This ETL pulls stream/river gauge data from the NWS [National Water Prediction Service (NWPS)](https://water.noaa.gov/)
API. NWPS republishes USGS instantaneous gauge observations (gage height and streamflow) alongside the NWS maintained
flood category for each gauge. USGS maintains the underlying observation data while the NWS maintains the flood
thresholds and resulting alarm state.

Each gauge within the configured bounding box is submitted to the TAK Server as a GeoJSON point feature, with the marker
color set by the observed NWS flood category (alarm state):

| Alarm State        | Flood Category | Marker Color |
| ------------------ | -------------- | ------------ |
| Major Flooding     | `major`        | `#B243B1`    |
| Moderate Flooding  | `moderate`     | `#D94B4A`    |
| Minor Flooding     | `minor`        | `#F5A623`    |
| Action Stage       | `action`       | `#FFDE63`    |
| No Flooding        | `no_flooding`  | `#98E09A`    |
| No Current Data    | *other*        | `#CCCCCC`    |

The observed gage height (ft), streamflow (cfs), observation time, and responsible NWS office are attached to each
feature's remarks and `metadata` properties.

## Configuration

The following values are configured via the CloudTAK Layer environment:

| Variable      | Description |
| ------------- | ----------- |
| `BoundingBox` | Bounding box limiting gauges to a given area, formatted as `xmin,ymin,xmax,ymax` (West Longitude, South Latitude, East Longitude, North Latitude) in decimal degrees. Western longitudes are negative. Defaults to the state of Colorado (`-109.06,36.99,-102.04,41.00`). |
| `DEBUG`       | Print the resulting GeoJSON Feature Collection in the logs. |

## Development

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the 
CloudTAK API.

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.

