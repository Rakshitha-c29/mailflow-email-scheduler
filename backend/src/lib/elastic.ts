import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env';

export const es = new Client({ node: env.ELASTICSEARCH_URL, requestTimeout: 10_000, maxRetries: 2 });
export const ES_INDEX = env.ELASTICSEARCH_INDEX;
