/**/
module.exports = function (app) {
var plugin = {};

plugin.id = 'collision-detector';
plugin.name = 'Collision detector';
plugin.description = 'Server plugin that signaling of the collision possibility via SignalK alarm system';

plugin.schema = {
	title: plugin.name,
	description: '',
	type: 'object',
	required: ['PosFreshBefore'],
	properties: {
		velocityVectorLengthInMn:{
			type: 'number',
			title: 'Collision detection distance, minutes of movement.',
			description: '',
			default: 10
		},
		timeouts:{
			type: 'object',
			title: 'Data actuality timeouts',
			properties: {
				PosFreshBefore:{
					type: 'number',
					title: 'The position of AIS targets is considered correct no longer than this time, seconds.',
					description: `All devices on your network must have the same time (with differents less than 1 sec.) -- check this and you can be sure that you see actual data.`,
					default: 600
				}
			}
		}
	}
};

var unsubscribes = []; 	// массив функций, которые отписываются от подписок (на обновления от сервера, например)

////////////////
plugin.start = function (options, restartPlugin) {
let self;
let selfContext = app.getSelfPath('uuid');
if(!selfContext) self = app.getSelfPath('mmsi');	// костыль на предмет https://github.com/SignalK/signalk-server/issues/1447
var AIS = {};
var collisions;
/////////////////////////// collisionDetector test ///////////////////////////////
//let collisionSegments;	// пересекающиеся отрезки, в тестовых целях
/////////////////////////// end collisionDetector test ///////////////////////////////
//app.debug('self',self,app.getSelfPath('navigation.datetime'));

// Подписка на изменение положения всех судов
// На что подписываемся
const TPVsubscribe = {
	"context": "vessels.*",
	"subscribe": [
		{
			"path": "navigation.position",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.courseOverGroundTrue",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.headingTrue",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.speedOverGround",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "design.length",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "design.beam",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		},
		{
			"path": "navigation.datetime",
			"format": "delta",
			"policy": "instant",
			"minPeriod": 0
		}
	]
}
// Подписка
// документации на эту штуку так и нет, но удалось узнать, что вызывать это можно много раз с разными подписками
app.subscriptionmanager.subscribe(	
	TPVsubscribe,	// подписка
	unsubscribes,	// массив функций отписки
	subscriptionError => {	// обработчик ошибки
		app.error('Error subscription to data:' + subscriptionError);
		app.setPluginError('Error subscription to data:'+subscriptionError.message);
	},
	doOnValue	// функция обработки каждой delta
); // end subscriptionmanager

// Обработчик сообщений подписки
function doOnValue(delta){	
//app.debug(delta.context);
//app.debug('navigation.datetime',app.getSelfPath('navigation.datetime'));
delta.updates.forEach(update => {
	//app.debug(update.source,update.timestamp);
	let timestamp = update.timestamp;	
	update.values.forEach(value => {	// если подписка только на координаты -- здесь будут только координаты
		//app.debug(value);
		if(!selfContext && delta.context.endsWith(self)) selfContext = delta.context;
		if(!AIS[delta.context]) AIS[delta.context] = {};
		switch(value.path){
		case "navigation.position":
			AIS[delta.context].position = value.value;	// {longitude: xx, latitude: xx} degrees
			// Поскольку у целей AIS нет navigation.datetime, timestamp будет из изменения координат
			if(!AIS[delta.context].datetime) AIS[delta.context].timestamp = Date.parse(update.timestamp); 	// milliseconds
			/*
			// Будем определь возможность столкновения только при изменении координат
			// однако, повороты отдельно, и если не пересчитывать на каждый поворот -- так себе получается
			// Определим координаты точек опасной зоны и координаты объемлющего
			// горизонтального прямоугольника для этого судна
			updCollisionArea(delta.context);	// 
			if(delta.context == selfContext) {
				// Определим возможность столкновения нас со всеми судами
				chkCollisions();
			}
			else {
				// Определим возможность столкновения этого судна с нами
				if(chkCollision(delta.context)) collisionAlarm(true);
			}
			*/
			break;
		case "navigation.courseOverGroundTrue":
			AIS[delta.context].courseOverGroundTrue = value.value;	// radian
			if(!AIS[delta.context].headingTrue) AIS[delta.context].course = value.value
			//AIS[delta.context].course = value.value;	// radian
			break;
		case 'navigation.headingTrue':
			AIS[delta.context].heading = value.value;	// radian
			//if(!AIS[delta.context].courseOverGroundTrue) AIS[delta.context].course = value.value
			AIS[delta.context].course = value.value;	// radian
			break;
		case "navigation.speedOverGround":
			AIS[delta.context].speed = value.value;	// m/sec
			break;
		case "design.length":
			AIS[delta.context].length = value.value.overall;	// m
			break;
		case "design.beam":
			AIS[delta.context].beam = value.value;	// m
			break;
		case "navigation.datetime":
			// у целей AIS в SignalK этого нет, и откуда берётся таймштамп там -- неизвестно.
			AIS[delta.context].datetime = Date.parse(value.value); 	// milliseconds
			AIS[delta.context].timestamp = AIS[delta.context].datetime;
			break;
		};

		// Будем определь возможность столкновения при изменении любых параметров
		// Это не менее чем в три раза чаще, чем только при изменении координат
		// Определим координаты точек опасной зоны и координаты объемлющего
		// горизонтального прямоугольника для этого судна
		updCollisionArea(delta.context);	// 
		if(delta.context == selfContext) {
			// Определим возможность столкновения нас со всеми судами
			chkCollisions();
		}
		else {
			// Определим возможность столкновения этого судна с нами
			if(chkCollision(delta.context)) collisionAlarm(true);
		}

	});
});
//app.debug(AIS);
}; 	// end function doOnValue
// Конец подписки на изменение положения всех судов

/*////////////////////////// collisionDetector test ///////////////////////////////
// Отладочный сервер
app.get(`/${plugin.id}/allvessels/`, function(request, response) {	
	response.json(AIS);
});
app.get(`/${plugin.id}/collisions/`, function(request, response) {	
	response.json(collisions);
});
/*////////////////////////// end collisionDetector test ///////////////////////////////





// Функции

function updCollisionArea(vesselID){
// Определим координаты точек опасной зоны и координаты объемлющего
// горизонтального прямоугольника для vesselID
if(!AIS[vesselID].position) return;
let toBack = 30;	// метров
if(AIS[vesselID].length) toBack = AIS[vesselID].length;
let bearing = 0;	// в SignalK нет разницы между отсутствием курса и направлением на север. Печаль.
if(AIS[vesselID].course) bearing = AIS[vesselID].course;	// radian
AIS[vesselID].collisionArea = [];
AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].position,toBack,bearing+Math.PI));	// назад
//app.debug('AIS[vesselID].position=',AIS[vesselID].position,'AIS[vesselID].rootPoint=',AIS[vesselID].rootPoint)
let toFront;
if(AIS[vesselID].speed>1) toFront = AIS[vesselID].speed * options.velocityVectorLengthInMn * 60 + toBack;	// speed is real, so cannot be compared to equal
else toFront = 2*toBack
//app.debug('toBack=',toBack,'toFront=',toFront,'bearing=',bearing);
//if(AIS[vesselID].course === undefined) {	// ромбик
if((bearing == 0) && (AIS[vesselID].speed<1)) {	// ромбик
	let aside = toFront/2;
	//let aside = toFront/10;
	//if(AIS[vesselID].beam) aside = AIS[vesselID].beam;
	//app.debug('aside=',aside);
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].position,aside,bearing-Math.PI/2));	// 
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing));	// 
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].position,aside,bearing+Math.PI/2));	// 
}
else {	// треугольник
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing-0.1));	// 
	AIS[vesselID].collisionArea.push(destinationPoint(AIS[vesselID].collisionArea[0],toFront,bearing+0.1));	// 
}
let longs = [], lats = [];
AIS[vesselID].collisionArea.forEach(point => {longs.push(point.longitude);lats.push(point.latitude)});
AIS[vesselID].squareArea = {topLeft: {longitude: Math.min.apply(null,longs), latitude: Math.max.apply(null,lats)},bottomRight: {longitude: Math.max.apply(null,longs), latitude: Math.min.apply(null,lats)}};	// 
} // end function updCollisionArea

function chkCollisions(){
// Определим возможность столкновения нас со всеми судами
collisions = {};
/////////////////////////// collisionDetector test ///////////////////////////////
//collisionSegments = {}; 	// объект для тестовых целей
/////////////////////////// end collisionDetector test ///////////////////////////////
let isCollision = false;
for(let vesselID in AIS){
	if(vesselID === selfContext) continue;
	if((Date.now()-AIS[vesselID].timestamp)>(options.timeouts.PosFreshBefore*1000)){
		//app.debug('Протухла информация о',vesselID);
		delete AIS[vesselID];
		continue;
	}
	if(chkCollision(vesselID)) isCollision = true;
}
if(isCollision) collisionAlarm(true);	// хотя бы одна цель AIS
else {
	const isNotificationsCollision = app.getSelfPath('notifications.danger.collision');
	if(isNotificationsCollision && isNotificationsCollision.value) collisionAlarm(false);
	// а иначе оно и так false
}
} // end function chkCollisions

function chkCollision(vesselID){
/*
AIS[vesselID].squareArea.topLeft.longitude
AIS[vesselID].squareArea.bottomRight.longitude
AIS[vesselID].squareArea.topLeft.latitude
AIS[vesselID].squareArea.bottomRight.latitude

AIS[selfContext].squareArea.topLeft.longitude
AIS[selfContext].squareArea.bottomRight.longitude
AIS[selfContext].squareArea.topLeft.latitude
AIS[selfContext].squareArea.bottomRight.latitude
*/
//app.debug('squareArea:',AIS[vesselID].squareArea);
if(!selfContext || !AIS[vesselID].squareArea || !AIS[selfContext].squareArea) return false;	// оно не сразу
// Проверяем пересечение прямоугольных областей
if(
	AIS[vesselID].squareArea.topLeft.longitude > AIS[selfContext].squareArea.bottomRight.longitude
	|| AIS[vesselID].squareArea.bottomRight.longitude < AIS[selfContext].squareArea.topLeft.longitude
	|| AIS[vesselID].squareArea.topLeft.latitude < AIS[selfContext].squareArea.bottomRight.latitude
	|| AIS[vesselID].squareArea.bottomRight.latitude > AIS[selfContext].squareArea.topLeft.latitude
) {
	//if(collisions.includes(vesselID)) {	// считаем, что собственное положение изменяется достаточно часто, а при этом массив collisions обнуляется.
	return false;	// эти области не пересекаются
}
// Области пересекаются -- определим общий горизонтальный прямоугольник
const unitedSquareArea = {
	topLeft: {
		longitude: Math.min(AIS[vesselID].squareArea.topLeft.longitude,AIS[selfContext].squareArea.topLeft.longitude), 
		latitude: Math.max(AIS[vesselID].squareArea.topLeft.latitude,AIS[selfContext].squareArea.topLeft.latitude)
	},
	bottomRight: {
		longitude: Math.max(AIS[vesselID].squareArea.bottomRight.longitude,AIS[selfContext].squareArea.bottomRight.longitude), 
		latitude: Math.min(AIS[vesselID].squareArea.bottomRight.latitude,AIS[selfContext].squareArea.bottomRight.latitude)
	}
};	// 
//app.debug('unitedSquareArea:',unitedSquareArea);
/*////////////////////////// collisionDetector test ///////////////////////////////
if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
if(!collisionSegments[vesselID].unitedSquareAreas) collisionSegments[vesselID].unitedSquareAreas = [];
collisionSegments[vesselID].unitedSquareAreas.push(unitedSquareArea);
/*////////////////////////// end collisionDetector test ///////////////////////////////

// Пересчитаем координаты точек collisionArea относительно общего прямоугольника,
// от верхнего левого угла, в метрах
let selfLocalCollisionArea = [], targetLocalCollisionArea = [];
AIS[selfContext].collisionArea.forEach(point=>{
	const x = equirectangularDistance(unitedSquareArea.topLeft,{longitude: point.longitude, latitude: unitedSquareArea.topLeft.latitude});
	const y = equirectangularDistance(unitedSquareArea.topLeft,{longitude: unitedSquareArea.topLeft.longitude, latitude: point.latitude});
	selfLocalCollisionArea.push([x,y]);
});
AIS[vesselID].collisionArea.forEach(point=>{
	const x = equirectangularDistance(unitedSquareArea.topLeft,{longitude: point.longitude, latitude: unitedSquareArea.topLeft.latitude});
	const y = equirectangularDistance(unitedSquareArea.topLeft,{longitude: unitedSquareArea.topLeft.longitude, latitude: point.latitude});
	targetLocalCollisionArea.push([x,y]);
});
//app.debug('targetLocalCollisionArea:',targetLocalCollisionArea);

// Определим, пересекаются ли какие-либо отрезки фигур collisionArea
// на самих и цели
//app.debug('\nchkCollision, selfLocalCollisionArea.length',selfLocalCollisionArea.length,'targetLocalCollisionArea.length',targetLocalCollisionArea.length);
let isIntersection = false;
let i,j,nextI,nextJ;	// они используются потом для отладки
const lenI = selfLocalCollisionArea.length, lenJ = targetLocalCollisionArea.length;
doIntersection: {
	for(i=0; i<lenI; i++){	// для каждого отрезка своей области нахождения
		nextI = i+1;
		if(nextI==lenI) nextI = 0;
		for(j=0; j<lenJ; j++){	// узнаем, пересекается ли он с каждым отрезком области другого судна
			nextJ = j+1;
			if(nextJ==lenJ) nextJ = 0;
			if(segmentIntersection(selfLocalCollisionArea[i],selfLocalCollisionArea[nextI],targetLocalCollisionArea[j],targetLocalCollisionArea[nextJ])){	// две точки первого отрезка, две точки второго отрезка
				isIntersection = true;
				break doIntersection;
			}
		}
	}
}

/*////////////////////////// collisionDetector test ///////////////////////////////
if(isIntersection){
	if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
	if(!collisionSegments[vesselID].segments) collisionSegments[vesselID].segments = [];
	collisionSegments[vesselID].segments.push([
		[AIS[selfContext].collisionArea[i],AIS[selfContext].collisionArea[nextI]],
		[AIS[vesselID].collisionArea[j],AIS[vesselID].collisionArea[nextJ]]
	]);
}
/*////////////////////////// end collisionDetector test ///////////////////////////////

// Возможно, вся область вероятного нахождения цели лежит внутри области
// нашего вероятного нахождения?
// наша область вероятного нахождения -- всегда треугольник в этот момент (иначе -- цель уже у нас на палубе).
if(!isIntersection){
	inside: {
		for(let point of targetLocalCollisionArea){	// для каждой точки области цели
			if(!isInTriangle_Vector(selfLocalCollisionArea[0], selfLocalCollisionArea[1], selfLocalCollisionArea[2], point)){	// точка вне нашего треугольника
				break inside;
			};
		};
		isIntersection = true;	// все точки лежат внутри треугольника		
		/*////////////////////////// collisionDetector test ///////////////////////////////
		if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
		if(!collisionSegments[vesselID].segments) collisionSegments[vesselID].segments = [];
		collisionSegments[vesselID].segments.push([
			[AIS[vesselID].collisionArea[0],AIS[vesselID].collisionArea[1]],
			[AIS[vesselID].collisionArea[2],AIS[vesselID].collisionArea[0]]
		]);
		/*////////////////////////// end collisionDetector test ///////////////////////////////
	}
};
// Возможно, вся область нашего вероятного нахождения лежит внутри области
// вероятного нахождения цели?
// область вероятного нахождения цели -- всегда треугольник в этот момент (иначе -- мы уже на палубе цели).
if(!isIntersection){
	inside: {
		for(let point of selfLocalCollisionArea){	// для каждой точки области цели
			if(!isInTriangle_Vector(targetLocalCollisionArea[0], targetLocalCollisionArea[1], targetLocalCollisionArea[2], point)){	// точка вне нашего треугольника
				break inside;
			};
		};
		isIntersection = true;	// все точки лежат внутри треугольника
	}
	/*////////////////////////// collisionDetector test ///////////////////////////////
	if(!collisionSegments[vesselID]) collisionSegments[vesselID] = {};
	if(!collisionSegments[vesselID].segments) collisionSegments[vesselID].segments = [];
	collisionSegments[vesselID].segments.push([
		[AIS[selfContext].collisionArea[0],AIS[selfContext].collisionArea[1]],
		[AIS[selfContext].collisionArea[2],AIS[selfContext].collisionArea[0]]
	]);
	/*////////////////////////// end collisionDetector test ///////////////////////////////
};

if(!isIntersection) return false;	// ни одна пара отрезков внутри объединённой области не пересекается

//if(vesselID == 'vessels.urn:mrn:imo:mmsi:244690773'){
//	app.debug('isIntersection with',vesselID,isIntersection,'отрезки',i,j);
//}
// Пересечение принятых областей равной вероятности нахождения судов имеется
collisions[vesselID] = {"lon":AIS[vesselID].position.longitude,"lat":AIS[vesselID].position.latitude};	// в формате Leaflet

return true; 
} // end function chkCollision

function collisionAlarm(status=false){
if(status) {
	app.handleMessage(plugin.id, {
		context: 'vessels.self',
		updates: [
			{
				values: [
					{
						"path": "notifications.danger.collision",
						"value": {
							"method": ["visual","sound"],
							"state": "alarm",
							"message": "Collision danger!",
							"source": plugin.id,
							"vessels": collisions,
							/*////////////////////////// end collisionDetector test ///////////////////////////////
							"collisionSegments": collisionSegments
							/*////////////////////////// collisionDetector test ///////////////////////////////
						},
					}
				],
				source: { label: plugin.id },
				timestamp: new Date().toISOString(),
			}
		]
	});
}
else {
	app.handleMessage(plugin.id, {
		context: 'vessels.self',
		updates: [
			{
				values: [
					{
						"path": "notifications.danger.collision",
						"value": null
					}
				],
				source: { label: plugin.id },
				timestamp: new Date().toISOString(),
			}
		]
	});
}
} // end function collisionAlarm



function destinationPoint(from,distance,bearing){
// http://www.movable-type.co.uk/scripts/latlong.html
// from: {longitude: xx, latitude: xx} degrees
// distance: meters
// bearing: clockwise from north radians
const R = 6371e3;	// meters
const rad = Math.PI/180;
const deg = 180/Math.PI;
const φ1 = from.latitude * rad;
const λ1 = from.longitude * rad;
const δ = distance / R; // angular distance in radians
const φ2 = Math.asin( Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(bearing) );
const λ2 = λ1 + Math.atan2(Math.sin(bearing)*Math.sin(δ)*Math.cos(φ1),Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));
return {longitude: λ2*deg, latitude: φ2*deg};
} // end function destinationPoint

function equirectangularDistance(from,to){
// https://www.movable-type.co.uk/scripts/latlong.html
// from,to: {longitude: xx, latitude: xx}
const rad = Math.PI/180;
const φ1 = from.latitude * rad;
const φ2 = to.latitude * rad;
const Δλ = (to.longitude-from.longitude) * rad;
const R = 6371e3;	// метров
const x = Δλ * Math.cos((φ1+φ2)/2);
const y = (φ2-φ1);
const d = Math.sqrt(x*x + y*y) * R;	// метров
return d;
} // end function equirectangularDistance

function segmentIntersection(a1,a2,b1,b2){
// https://acmp.ru/article.asp?id_text=170
// Определяет пересечение отрезков A(ax1,ay1,ax2,ay2) и B (bx1,by1,bx2,by2),
// функция возвращает TRUE - если отрезки пересекаются, а если пересекаются 
// в концах или вовсе не пересекаются, возвращается FALSE (ложь)
let [ax1,ay1] = a1;
let [ax2,ay2] = a2;
let [bx1,by1] = b1;
let [bx2,by2] = b2;
let v1,v2,v3,v4;
v1=(bx2-bx1)*(ay1-by1)-(by2-by1)*(ax1-bx1);
v2=(bx2-bx1)*(ay2-by1)-(by2-by1)*(ax2-bx1);
v3=(ax2-ax1)*(by1-ay1)-(ay2-ay1)*(bx1-ax1);
v4=(ax2-ax1)*(by2-ay1)-(ay2-ay1)*(bx2-ax1);
return ((v1*v2)<0) && ((v3*v4)<0);
};

function isInTriangle_Vector(A, B, C, P){
// http://cyber-code.ru/tochka_v_treugolnike/
// Находится ли точка в треугольнике
// точки A [x,y], B,C -- треугольник
// P [x,y] -- проверяемая точка
let [aAx, aAy] = A;
let [aBx, aBy] = B;
let [aCx, aCy] = C;
let [aPx, aPy] = P;
let  Bx, By, Cx, Cy, Px, Py;
let  m, l; // мю и лямбда
// переносим треугольник точкой А в (0;0).
Bx = aBx - aAx; By = aBy - aAy;
Cx = aCx - aAx; Cy = aCy - aAy;
Px = aPx - aAx; Py = aPy - aAy;

m = (Px*By - Bx*Py) / (Cx*By - Bx*Cy);
if((m >= 0) && (m <= 1)){
	l = (Px - m*Cx) / Bx;
	return ((l >= 0) && ((m + l) <= 1));
};
return false;
}; // end function isInTriangle_Vector

}; // end plugin.start

/////////////
plugin.stop = function () {
unsubscribes.forEach(f => f());
unsubscribes = [];
}; // end plugin.stop

return plugin;
};


