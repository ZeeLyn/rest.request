import axios from "axios";
axios.defaults.headers.post["Content-type"] = "application/json";
axios.defaults.headers.put["Content-type"] = "application/json";
var __axios_defaults = Object.assign(axios.defaults, {
	timeout: 5 * 1000,
	$error_network(err) {
		console.error("Network Error=>", err);
	},
	validateStatus: function (status) {
		return status >= 200 && status < 300;
	},
});
const GetInstance = () => {
	var instance = null;

	return {
		create: () => {
			if (instance) return instance;
			var finallyCall = (response) => {
				if (__axios_defaults.$finally) __axios_defaults.$finally(response);
			};
			instance = axios.create(__axios_defaults);
			instance.interceptors.request.use((config) => {
				if (__axios_defaults.$on_before_request) __axios_defaults.$on_before_request(config);
				return config;
			});
			instance.interceptors.response.use(
				(response) => {
					finallyCall(response);
					return response;
				},
				(err) => {
					if (!err.response) {
						finallyCall(err);
						if (err.config.$error_network) err.config.$error_network(err);
						return Promise.reject(err);
					}
					if (err.response.status) {
						var invoke = err.response.config["$" + err.response.status];
						if (invoke) invoke(err);
					}
					finallyCall(err);
					return Promise.reject(err);
				},
			);

			return instance;
		},
	};
};

const __axios_iunstance_factory = GetInstance();
export default {
	defaults(invoke) {
		if (invoke) invoke(__axios_defaults);
	},
	get(url, options) {
		return this._request(url, { method: "get", ...options });
	},
	post(url, options) {
		return this._request(url, { method: "post", ...options });
	},
	delete(url, options) {
		return this._request(url, { method: "delete", ...options });
	},
	head(url, options) {
		return this._request(url, { method: "head", ...options });
	},
	options(url, options) {
		return this._request(url, { method: "options", ...options });
	},
	put(url, options) {
		return this._request(url, { method: "put", ...options });
	},
	patch(url, options) {
		return this._request(url, { method: "patch", ...options });
	},
	_request(url, options) {
		let instance = __axios_iunstance_factory.create();
		var promise = instance.request(url, options);
		return promise;
	},
};
